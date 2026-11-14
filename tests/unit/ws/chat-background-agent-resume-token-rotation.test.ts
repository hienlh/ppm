/**
 * A reviewer agent woken again by `SendMessage` runs on inside the chat's subprocess after the
 * turn that woke it ends. The token rotation must not take it for an idle subprocess and close it:
 * that killed the reviewer mid-review and left the chat waiting for a notification that never came.
 *
 * The events below are the ones the real CLI sent in that incident (session trace of af31cf91):
 * a first review that ran and finished, a `SendMessage` whose result is "Resuming agent …", a
 * `task_started` reusing the agent's task id, then the turn's `done` while the agent kept working.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, setSystemTime } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import "../../test-setup.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatWebSocket, getSessionTurnState, hasBackgroundWork } from "../../../src/server/ws/chat.ts";
import { runTokenRotationSweep } from "../../../src/server/ws/chat-token-rotation.ts";
import { until } from "../../helpers/queued-turns-provider.ts";
import type { AIProvider, ChatEvent, Session, SessionConfig } from "../../../src/providers/provider.interface.ts";

const testKeyPath = resolve(tmpdir(), `ppm-test-bg-resume-rotation-${Date.now()}.key`);
setKeyPath(testKeyPath);

const AGENT = "a59f75602d3cccd4f";
/**
 * Longer than any quiet window the rotation may hold off for. Written out rather than imported,
 * so this file also loads against a build without the safety net and fails there on behaviour.
 */
const PAST_QUIET_WINDOW_MS = 10 * 60_000;

/** The real CLI's events for each scripted message; everything else answers with plain text. */
function turnEvents(message: string): ChatEvent[] {
  if (message === "review") {
    return [
      { type: "tool_use", tool: "Agent", input: { subagent_type: "code-reviewer", prompt: "review" }, toolUseId: "toolu_agent" },
      { type: "system", subtype: "task_started", taskId: AGENT, taskToolUseId: "toolu_agent" },
      { type: "system", subtype: "task_notification", taskId: AGENT, taskToolUseId: "toolu_agent", taskStatus: "completed", outputFile: "/tmp/agent.output" },
      { type: "tool_result", output: "[Subagent hand-back] no blocking issues", toolUseId: "toolu_agent" },
      { type: "text", content: "Fixing the review findings." },
    ] as ChatEvent[];
  }
  if (message === "resume") {
    return [
      { type: "tool_use", tool: "SendMessage", input: { to: AGENT, message: "Re-review the fix commit" }, toolUseId: "toolu_send" },
      { type: "system", subtype: "background_tasks_changed" },
      { type: "system", subtype: "task_started", taskId: AGENT, taskToolUseId: "toolu_send" },
      { type: "tool_result", output: JSON.stringify([{ type: "text", text: JSON.stringify({ success: true, message: "Resuming agent a59f756", resumedAgentId: AGENT }) }]), toolUseId: "toolu_send" },
      { type: "text", content: "The reviewer is re-checking that commit now; I'll report once it comes back clean." },
    ] as ChatEvent[];
  }
  return [{ type: "text", content: `echo: ${message}` } as ChatEvent];
}

/**
 * Like the SDK's stream: stays open after `done`, takes the next message off `pushMessage`, and
 * between turns carries whatever the subprocess emits on its own (`emit`) — a background agent's
 * events, its task notification.
 */
class ResumedAgentProvider implements AIProvider {
  id = "bg-resume-rotation";
  name = "Resumed Agent Provider";
  private sessions = new Map<string, Session>();
  private streams = new Map<string, { queue: Array<ChatEvent | string>; wake?: () => void; controller: AbortController }>();
  abortReasons: Array<{ sessionId: string; reason?: string }> = [];
  /** The account and token each live subprocess was started with. */
  credentials = new Map<string, { accountId: string; oauthToken: string }>();

  async createSession(config: SessionConfig): Promise<Session> {
    const session: Session = { id: crypto.randomUUID(), providerId: this.id, title: config.title ?? "Test", createdAt: new Date().toISOString() };
    this.sessions.set(session.id, session);
    return session;
  }
  async resumeSession(sessionId: string): Promise<Session> { return this.sessions.get(sessionId)!; }
  async listSessions() { return []; }
  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }

  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    const stream = { queue: [message] as Array<ChatEvent | string>, controller: new AbortController() };
    this.streams.set(sessionId, stream);
    stream.controller.signal.addEventListener("abort", () => stream.wake?.(), { once: true });
    try {
      while (!stream.controller.signal.aborted) {
        const next = stream.queue.shift();
        if (next === undefined) {
          await new Promise<void>((r) => { stream.wake = r; });
          continue;
        }
        if (typeof next === "string") {
          for (const ev of turnEvents(next)) yield ev;
          yield { type: "done", sessionId } as ChatEvent;
        } else {
          yield next;
        }
      }
    } finally {
      this.streams.delete(sessionId);
    }
  }
  private enqueue(sessionId: string, item: ChatEvent | string): void {
    const stream = this.streams.get(sessionId);
    if (!stream) throw new Error(`no live stream for ${sessionId}`);
    stream.queue.push(item);
    stream.wake?.();
  }
  pushMessage(sessionId: string, content: string): void { this.enqueue(sessionId, content); }
  /** Something the subprocess sends between turns. */
  emit(sessionId: string, event: ChatEvent): void { this.enqueue(sessionId, event); }
  abortQuery(sessionId: string, reason?: string): void {
    this.abortReasons.push({ sessionId, reason });
    this.streams.get(sessionId)?.controller.abort();
  }
  hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  liveSubprocessCredentials() {
    return [...this.streams.keys()].flatMap((sessionId) => {
      const credential = this.credentials.get(sessionId);
      return credential ? [{ sessionId, credential }] : [];
    });
  }
}

const provider = new ResumedAgentProvider();
const realGet = providerRegistry.get.bind(providerRegistry);

beforeAll(() => {
  providerRegistry.register(provider);
  // The token rotation asks the Claude provider for its live subprocesses; answer for this
  // test's provider and leave every other call to the real one.
  providerRegistry.get = ((id: string) => {
    if (id !== "claude") return realGet(id);
    const claude = realGet("claude")!;
    return new Proxy(claude, {
      get: (target, prop) => (prop === "liveSubprocessCredentials" ? () => provider.liveSubprocessCredentials() : Reflect.get(target, prop)),
    });
  }) as typeof providerRegistry.get;
});
afterAll(() => {
  providerRegistry.get = realGet;
  if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
});

const originalFetch = globalThis.fetch;
let renewals = 0;
beforeEach(() => {
  renewals = 0;
  globalThis.fetch = mock(() => {
    renewals++;
    return Promise.resolve(new Response(
      JSON.stringify({ access_token: `sk-ant-oat-renewed-${crypto.randomUUID()}`, refresh_token: "rotated", expires_in: 28800 }),
      { status: 200 },
    ));
  }) as any;
});
const sockets: any[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
});

/** A chat whose subprocess holds a token that is due for an early renewal. */
async function chatOnDueAccount() {
  const token = `sk-ant-oat-old-${crypto.randomUUID()}`;
  const account = accountService.add({
    email: `rotation-${crypto.randomUUID()}@test.com`,
    accessToken: token,
    refreshToken: "refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 1800,
  });
  const session = await chatService.createSession(provider.id, {});
  provider.credentials.set(session.id, { accountId: account.id, oauthToken: token });
  const messages: any[] = [];
  const socket = { data: { sessionId: session.id, providerHint: provider.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  const say = async (content: string, doneCount: number) => {
    await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content }));
    await until(() => messages.filter((m) => m.type === "done").length === doneCount && !getSessionTurnState(session.id).running, `turn ${doneCount} to end`);
  };
  return { id: session.id, say };
}

const rotatedAway = (sessionId: string) => provider.abortReasons.some((a) => a.sessionId === sessionId && a.reason === "token_rotated");

it("keeps a reviewer resumed by SendMessage alive through the token rotation, and lets it go once it is done", async () => {
  const { id, say } = await chatOnDueAccount();
  await say("review", 1);
  await say("resume", 2);

  // The turn is over and the reviewer is still working inside the subprocess.
  expect(hasBackgroundWork(id)).toBe(true);
  await runTokenRotationSweep();
  expect(rotatedAway(id)).toBe(false);
  expect(provider.hasStreamingSession(id)).toBe(true);
  expect(renewals).toBe(0);

  // The reviewer reports back.
  provider.emit(id, { type: "system", subtype: "task_notification", taskId: AGENT, taskToolUseId: "toolu_send", taskStatus: "completed", outputFile: "/tmp/agent.output" } as ChatEvent);
  await until(() => !hasBackgroundWork(id), "the reviewer to be counted as done");

  // Nothing runs any more: the account is renewed and the idle subprocess moved onto it.
  await runTokenRotationSweep();
  expect(renewals).toBe(1);
  expect(rotatedAway(id)).toBe(true);
});

it("holds the renewal while the subprocess is still emitting a subagent's events, even with no task reported", async () => {
  const { id, say } = await chatOnDueAccount();
  await say("plain", 1);

  // A subagent's own event arrives after the turn ended, with no task the session knows about.
  provider.emit(id, { type: "tool_use", tool: "Bash", input: { command: "bun test" }, toolUseId: "toolu_child", parentToolUseId: "toolu_unknown" } as ChatEvent);
  await Bun.sleep(30);
  expect(hasBackgroundWork(id)).toBe(false);
  await runTokenRotationSweep();
  expect(rotatedAway(id)).toBe(false);
  expect(renewals).toBe(0);

  // Quiet for longer than the window: an ordinary idle subprocess again.
  setSystemTime(new Date(Date.now() + PAST_QUIET_WINDOW_MS));
  await runTokenRotationSweep();
  expect(rotatedAway(id)).toBe(true);
});

it("forgets the tasks of a subprocess that is gone, so the next one is not held busy by them", async () => {
  const { id, say } = await chatOnDueAccount();
  await say("review", 1);
  await say("resume", 2);
  expect(hasBackgroundWork(id)).toBe(true);

  // The subprocess goes without the reviewer's end ever being reported.
  provider.abortQuery(id, "test_teardown");
  await until(() => !provider.hasStreamingSession(id), "the subprocess to go");
  await until(() => !hasBackgroundWork(id), "the session to stop counting the dead reviewer");
});
