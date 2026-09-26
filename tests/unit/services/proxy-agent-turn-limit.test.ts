/**
 * The proxy's cap on concurrent agent turns.
 *
 * Every turn is an agent subprocess, so an unbounded burst from a retrying client is what
 * pinned the server until the supervisor killed it. Past the cap a request must be refused
 * at once — 429 with Retry-After, in the caller's dialect — and a slot must come back as
 * soon as a turn ends, including a streamed one the client walks away from.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { forwardAgentChatCompletions } from "../../../src/services/proxy-agent-bridge.ts";
import { forwardAgentMessages } from "../../../src/services/proxy-agent-anthropic-bridge.ts";
import { MAX_CONCURRENT_PROXY_TURNS, activeProxyTurnCount } from "../../../src/services/proxy-agent-turn.ts";
import type { AIProvider, ChatEvent, Session } from "../../../src/types/chat.ts";

/** Streams one word and then never finishes, like a turn still being worked on. */
class StuckProvider implements AIProvider {
  name = "Stuck";
  n = 0;
  constructor(readonly id: string) {}
  async createSession(): Promise<Session> {
    return { id: `stuck-${++this.n}`, providerId: this.id, title: "t", createdAt: new Date().toISOString() } as Session;
  }
  async resumeSession(): Promise<Session> { throw new Error("unused"); }
  async listSessions() { return []; }
  async deleteSession() {}
  async *sendMessage(): AsyncIterable<ChatEvent> {
    yield { type: "text", content: "working" };
    await new Promise(() => {});
  }
}

beforeAll(() => { providerRegistry.register(new StuckProvider("stuck-agent")); });

const chat = () => forwardAgentChatCompletions("stuck-agent", {
  model: "m", stream: true, messages: [{ role: "user", content: "hi" }],
} as any);

describe("proxy turn concurrency cap", () => {
  it("refuses past the cap with 429 + Retry-After, and frees a slot when a stream is dropped", async () => {
    const running: Response[] = [];
    for (let i = 0; i < MAX_CONCURRENT_PROXY_TURNS; i++) {
      const res = await chat();
      expect(res.status).toBe(200);
      running.push(res);
    }
    expect(activeProxyTurnCount()).toBe(MAX_CONCURRENT_PROXY_TURNS);

    const refused = await chat();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("5");
    expect(((await refused.json()) as any).error.message).toContain("busy");

    // The Anthropic dialect shares the same pool and refuses in its own shape.
    const refusedAnthropic = await forwardAgentMessages("stuck-agent", {
      model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(refusedAnthropic.status).toBe(429);
    expect(((await refusedAnthropic.json()) as any).type).toBe("error");

    // A client hanging up on a stream is what releases its slot.
    await running.pop()!.body!.cancel();
    expect(activeProxyTurnCount()).toBe(MAX_CONCURRENT_PROXY_TURNS - 1);
    const admitted = await chat();
    expect(admitted.status).toBe(200);
    running.push(admitted);

    for (const res of running) await res.body!.cancel();
    expect(activeProxyTurnCount()).toBe(0);
  });
});
