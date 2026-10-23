/**
 * A Claude subprocess keeps the model, effort and thinking it was built with. A headless
 * follow-up asking for others must therefore restart it between turns, as `set_model` does,
 * and be refused while a turn runs rather than silently run on the wrong model.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { setSessionMetadata } from "../../../src/services/db.service.ts";
import { listRunningSessions } from "../../../src/server/ws/chat.ts";
import { BUSY_BACKGROUND_WORK, BUSY_DIFFERENT_MODEL, startHeadlessTurn } from "../../../src/server/ws/chat-headless-turn.ts";
import { backgroundShellRegistry } from "../../../src/services/background-shell-registry.ts";
import type { AIProvider, Session, SessionConfig, ChatEvent, SendMessageOpts } from "../../../src/providers/provider.interface.ts";

/**
 * Stands in for the Claude provider under its id: a generator that, like the SDK's, awaits
 * the next `pushMessage` after `done` instead of returning, recording what each query was
 * started with. The real provider is put back once the file is done.
 */
class FakeClaude implements AIProvider {
  id = "claude";
  name = "Fake Claude";
  sessions = new Map<string, Session>();
  private aborts = new Map<string, AbortController>();
  private nextMessage = new Map<string, (content: string | undefined) => void>();
  private holds = new Map<string, () => void>();
  queries: Array<{ sessionId: string; message: string; opts?: SendMessageOpts }> = [];
  pushes: Array<{ sessionId: string; content: string }> = [];
  abortReasons: string[] = [];

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = { id, providerId: this.id, title: config.title ?? "Test", projectName: config.projectName, projectPath: config.projectPath, createdAt: new Date().toISOString() };
    this.sessions.set(id, session);
    if (config.projectPath) setSessionMetadata(id, config.projectName, config.projectPath);
    return session;
  }
  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    return s;
  }
  async listSessions() { return []; }
  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }

  /** `hold:` messages park the turn, after its first event, until `release()`; everything else answers at once. */
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    this.queries.push({ sessionId, message, opts });
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    let current: string | undefined = message;
    while (current !== undefined && !controller.signal.aborted) {
      if (current.startsWith("hold:")) {
        yield { type: "text", content: "working" };
        await new Promise<void>((resolve) => {
          this.holds.set(sessionId, resolve);
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (controller.signal.aborted) break;
      }
      yield { type: "text", content: `echo: ${current}` };
      yield { type: "done", sessionId };
      current = await new Promise<string | undefined>((resolve) => {
        this.nextMessage.set(sessionId, resolve);
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    this.aborts.delete(sessionId);
  }
  pushMessage(sessionId: string, content: string): void {
    this.pushes.push({ sessionId, content });
    const resolve = this.nextMessage.get(sessionId);
    if (resolve) { this.nextMessage.delete(sessionId); resolve(content); }
  }
  abortQuery(sessionId: string, reason?: string): void {
    this.abortReasons.push(reason ?? "");
    this.aborts.get(sessionId)?.abort();
  }
  release(sessionId: string): void { this.holds.get(sessionId)?.(); }
  hasStreamingSession(sessionId: string): boolean { return this.aborts.has(sessionId); }
}

const fake = new FakeClaude();
const realClaude = providerRegistry.get("claude")!;
beforeAll(() => providerRegistry.register(fake));
afterAll(() => providerRegistry.register(realClaude));

const running = (id: string) => listRunningSessions().some((s) => s.sessionId === id);
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("headless follow-up on a live Claude session", () => {
  it("restarts an idle subprocess so the next query is built with the new model", async () => {
    const session = await chatService.createSession("claude", {});
    await startHeadlessTurn(session.id, { content: "one", providerId: "claude", model: "claude-opus-5-5" });
    await until(() => fake.queries.length === 1 && !running(session.id), "the first turn");
    expect(fake.queries[0]!.opts?.model).toBe("claude-opus-5-5");
    expect(fake.hasStreamingSession(session.id)).toBe(true);

    const result = await startHeadlessTurn(session.id, { content: "two", providerId: "claude", model: "claude-haiku-4-5" });
    expect(result.queued).toBe(false);
    expect(fake.abortReasons).toContain("headless_model_change");
    await until(() => fake.queries.length === 2, "the second query");
    expect(fake.queries[1]!.opts?.model).toBe("claude-haiku-4-5");
    expect(fake.pushes.filter((p) => p.sessionId === session.id)).toHaveLength(0);
    await until(() => !running(session.id), "the second turn");
    fake.abortQuery(session.id, "test_cleanup");
  });

  it("refuses a different model while a turn runs, and pushes the same model as a follow-up", async () => {
    const session = await chatService.createSession("claude", {});
    await startHeadlessTurn(session.id, { content: "hold: one", providerId: "claude", model: "claude-opus-5-5" });
    await until(() => running(session.id) && fake.hasStreamingSession(session.id), "the turn to start");

    await expect(startHeadlessTurn(session.id, { content: "two", providerId: "claude", model: "claude-haiku-4-5" })).rejects.toThrow(BUSY_DIFFERENT_MODEL);
    expect(fake.abortReasons.filter((r) => r === "headless_model_change")).toHaveLength(1);

    const same = await startHeadlessTurn(session.id, { content: "three", providerId: "claude", model: "claude-opus-5-5" });
    expect(same.queued).toBe(true);
    expect(fake.pushes.some((p) => p.sessionId === session.id && p.content === "three")).toBe(true);

    fake.release(session.id);
    await until(() => !running(session.id), "the turn to end");
    fake.abortQuery(session.id, "test_cleanup");
  });

  it("refuses to restart an idle subprocess that still runs a background shell", async () => {
    const session = await chatService.createSession("claude", {});
    await startHeadlessTurn(session.id, { content: "one", providerId: "claude", model: "claude-opus-5-5" });
    await until(() => !running(session.id) && fake.hasStreamingSession(session.id), "the first turn");
    backgroundShellRegistry.register(session.id, { shellId: "sh-1", command: "bun test --watch", outputPath: "/tmp/out", toolUseId: "tu-1" });
    const abortsBefore = fake.abortReasons.length;
    try {
      await expect(startHeadlessTurn(session.id, { content: "two", providerId: "claude", model: "claude-haiku-4-5" })).rejects.toThrow(BUSY_BACKGROUND_WORK);
      expect(fake.abortReasons).toHaveLength(abortsBefore);
      expect(fake.hasStreamingSession(session.id)).toBe(true);
    } finally {
      backgroundShellRegistry.clearSession(session.id);
      fake.abortQuery(session.id, "test_cleanup");
    }
  });
});
