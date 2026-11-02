import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import { chatService } from "../../../../src/services/chat.service.ts";
import { leftoverSessionActivity } from "../../../../src/server/ws/chat.ts";
import type { AIProvider, ChatEvent, Session } from "../../../../src/types/chat.ts";

/** A provider whose turn keeps running until the test ends it. */
class HeldTurnProvider implements AIProvider {
  id = "held-turn";
  name = "Held turn";
  private started: (() => void) | null = null;
  private gate: Promise<void> = Promise.resolve();

  /** Runs a turn of `sessionId` the way a schedule or a bot does, no browser connected; resolves once it is underway. */
  async startTurn(sessionId: string): Promise<() => Promise<void>> {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    const underway = new Promise<void>((r) => { this.started = r; });
    const drained = (async () => {
      for await (const _ of chatService.sendMessage(this.id, sessionId, "keep working", { origin: "scheduler" })) { /* drain */ }
    })();
    await underway;
    return async () => { release(); await drained; };
  }

  async createSession(): Promise<Session> {
    return { id: crypto.randomUUID(), providerId: this.id, title: "t", createdAt: new Date().toISOString() };
  }
  async resumeSession(id: string): Promise<Session> {
    return { id, providerId: this.id, title: "t", createdAt: new Date().toISOString() };
  }
  async listSessions() { return []; }
  async deleteSession() {}

  async *sendMessage(sessionId: string): AsyncIterable<ChatEvent> {
    yield { type: "text", content: "working" };
    this.started?.();
    await this.gate;
    yield { type: "done", sessionId, resultSubtype: "success" };
  }
}

const provider = new HeldTurnProvider();
providerRegistry.register(provider);

describe("what the leftover sweep counts as a busy session", () => {
  it("is busy while a turn runs with no socket open for the session, and idle once it ends", async () => {
    const sessionId = crypto.randomUUID();
    const endTurn = await provider.startTurn(sessionId);

    expect(leftoverSessionActivity(sessionId).busy).toBe(true);

    const before = Date.now();
    await endTurn();
    const after = leftoverSessionActivity(sessionId);
    expect(after.busy).toBe(false);
    expect(after.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it("is idle, with nothing to measure from, for a session that never ran here", () => {
    expect(leftoverSessionActivity(crypto.randomUUID())).toEqual({ busy: false, lastActiveAt: undefined });
  });
});
