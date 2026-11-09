/**
 * The effort a chat runs at has to reach every client, not just the pick: before any turn from
 * the settings files, and from the CLI's own answer at each turn's start. Driven through the real
 * socket handler with the mock provider standing in for Claude.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { effortOverrideLogLine, refreshEffortStatus } from "../../../src/server/ws/chat-effort-status.ts";
import type { EffortStatus } from "../../../src/shared/effort-status.ts";

const FROM_FILES: EffortStatus = { env: { value: "max", source: "userSettings", file: "~/.claude/settings.json" } };
const FROM_CLI: EffortStatus = { ...FROM_FILES, observed: { requested: "high", applied: "max", model: "claude-opus-5-5" } };

const restores: Array<() => void> = [];
const sockets: any[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  for (const restore of restores.splice(0)) restore();
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  return { socket, messages };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Give the mock provider Claude's two effort methods, answering from `answers` in turn. */
function overridable(answers: Array<EffortStatus | null>) {
  const provider = providerRegistry.get("mock")! as any;
  const reads: string[] = [];
  provider.readEffortStatus = async (sessionId: string) => { reads.push(sessionId); return answers.shift() ?? null; };
  provider.estimateEffortStatus = () => FROM_FILES;
  restores.push(() => { delete provider.readEffortStatus; delete provider.estimateEffortStatus; });
  const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string) {
    yield { type: "system", subtype: "init" };
    yield { type: "text", content: "ok" };
    yield { type: "done", sessionId };
  } as never);
  restores.push(() => send.mockRestore());
  return reads;
}

const greeting = (messages: any[]) => messages.filter((m) => m.type === "session_state").at(-1);

it("greets with what the settings files say, then with the CLI's answer once a turn has asked it", async () => {
  const session = await chatService.createSession("mock", {});
  const reads = overridable([FROM_CLI, FROM_CLI]);
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "ready" }));
  expect(greeting(live.messages).effortStatus).toEqual(FROM_FILES);

  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "hi" }));
  await until(() => live.messages.some((m) => m.type === "effort_status"), "the CLI's answer");
  expect(live.messages.find((m) => m.type === "effort_status").status).toEqual(FROM_CLI);
  expect(reads).toEqual([session.id]);
  await until(() => live.messages.some((m) => m.type === "phase_changed" && m.phase === "idle"), "the turn to end");

  // A device opening the chat later is told the CLI's answer, not the files' guess.
  const later = connect(session.id);
  expect(greeting(later.messages).effortStatus).toEqual(FROM_CLI);

  // The next turn asks again; the same answer is not sent twice.
  const idleCount = () => live.messages.filter((m) => m.type === "phase_changed" && m.phase === "idle").length;
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "again" }));
  await until(() => idleCount() === 2 && reads.length === 2, "the second turn");
  expect(live.messages.filter((m) => m.type === "effort_status")).toHaveLength(1);
});

it("keeps the CLI's answer across an effort pick, and drops it with the model it was about", async () => {
  const session = await chatService.createSession("mock", {});
  overridable([FROM_CLI]);
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "hi" }));
  await until(() => live.messages.some((m) => m.type === "effort_status"), "the CLI's answer");
  await until(() => live.messages.some((m) => m.type === "phase_changed" && m.phase === "idle"), "the turn to end");

  // The variable outranks any pick, so the answer still says what runs.
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "set_effort", effort: "low" }));
  expect(greeting(live.messages)).toMatchObject({ effort: "low", effortStatus: FROM_CLI });
  // The thinking toggle's greeting carries it too, or the chip would fall back to the pick.
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "set_thinking", enabled: false }));
  expect(greeting(live.messages)).toMatchObject({ thinking: false, effortStatus: FROM_CLI });

  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "set_model", model: "claude-haiku-4-5" }));
  expect(greeting(live.messages).effortStatus).toEqual(FROM_FILES);
});

it("says nothing about effort for a provider nothing overrides", async () => {
  const session = await chatService.createSession("mock", {});
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "ready" }));
  expect(greeting(live.messages).effortStatus).toBeNull();
});

it("logs a turn whose effort is not the one it was started with", () => {
  expect(effortOverrideLogLine(FROM_CLI)).toBe("Effort high was picked; Claude Code sends max (CLAUDE_CODE_EFFORT_LEVEL=max in ~/.claude/settings.json)");
  expect(effortOverrideLogLine({ observed: { requested: "high", applied: "high" } })).toBeNull();
  expect(effortOverrideLogLine({ observed: { requested: "max", applied: "high", model: "claude-opus-4-5" } }))
    .toBe("Effort max was picked; Claude Code sends high (what claude-opus-4-5 allows)");
});

it("leaves the status alone when the CLI cannot answer or the session moved on", async () => {
  const sent: unknown[] = [];
  const session = { providerId: "claude", effortStatus: FROM_FILES };
  const base = { sessionId: "s1", session, broadcast: (e: unknown) => sent.push(e), log: () => {} };
  // Unawaited beside the turn: a rejection here would reach the server's fatal-error handler.
  await refreshEffortStatus({ ...base, isCurrent: () => true, provider: { readEffortStatus: async () => { throw new Error("CLI gone"); } } });
  await refreshEffortStatus({ ...base, isCurrent: () => true, provider: { readEffortStatus: async () => null } });
  await refreshEffortStatus({ ...base, isCurrent: () => false, provider: { readEffortStatus: async () => FROM_CLI } });
  expect(sent).toEqual([]);
  expect(session.effortStatus).toEqual(FROM_FILES);
});
