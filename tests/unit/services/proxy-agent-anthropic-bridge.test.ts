/**
 * The Anthropic-dialect half of the provider-scoped proxy. Mirrors
 * proxy-agent-bridge.test.ts so the two endpoints cannot drift: same fake
 * provider, same guarantees, different wire format.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { forwardAgentMessages } from "../../../src/services/proxy-agent-anthropic-bridge.ts";
import {
  buildPromptFromAnthropicMessages, hasUnsupportedAnthropicBlocks, anthropicError,
} from "../../../src/services/proxy-anthropic-format.ts";
import type { AIProvider, ChatEvent, Session } from "../../../src/types/chat.ts";

const FULL_USAGE = {
  model: "fake-1", inputTokens: 10, outputTokens: 7, cacheReadTokens: 5,
  cacheWriteTokens: 3, contextWindow: 200_000, costUsd: 0.01,
  cacheHitRate: 0.5, coldStart: false,
};

class FakeProvider implements AIProvider {
  name = "Fake Anthropic";
  script: ChatEvent[] = [];
  seenMessage = "";
  deleted: string[] = [];
  constructor(readonly id: string) {}
  async createSession(): Promise<Session> {
    return { id: "s-1", providerId: this.id, title: "t", createdAt: new Date().toISOString() } as Session;
  }
  async resumeSession(): Promise<Session> { throw new Error("unused"); }
  async listSessions() { return []; }
  async deleteSession(id: string) { this.deleted.push(id); }
  async *sendMessage(_id: string, message: string): AsyncIterable<ChatEvent> {
    this.seenMessage = message;
    for (const ev of this.script) yield ev;
  }
}

const fake = new FakeProvider("test-anthropic");
beforeAll(() => { providerRegistry.register(fake); });

const body = (extra: Record<string, unknown> = {}) => ({
  model: "fake-1",
  messages: [{ role: "user", content: "xin chao" }],
  ...extra,
});

/** Split an Anthropic SSE body into (event name, payload) pairs. */
async function sseEvents(res: Response): Promise<Array<[string, any]>> {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    const ev = /^event: (.+)$/m.exec(block)?.[1] ?? "";
    const data = /^data: (.+)$/m.exec(block)?.[1] ?? "{}";
    return [ev, JSON.parse(data)] as [string, any];
  });
}

describe("proxy agent bridge — anthropic dialect", () => {
  it("returns a Messages-shaped response with provider usage", async () => {
    fake.script = [
      { type: "thinking", content: "ignored" },
      { type: "text", content: "Xin " },
      { type: "text", content: "chao!" },
      { type: "done", sessionId: "s-1", usage: FULL_USAGE },
    ];
    const res = await forwardAgentMessages("test-anthropic", body());
    expect(res.status).toBe(200);
    const j = await res.json() as any;

    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(j.content).toEqual([{ type: "text", text: "Xin chao!" }]);
    expect(j.stop_reason).toBe("end_turn");
    expect(j.usage).toEqual({ input_tokens: 18, output_tokens: 7 });
    expect(j.id).toStartWith("msg_");
  });

  it("takes system from the top-level field, not a message role", async () => {
    fake.script = [{ type: "text", content: "ok" }, { type: "done", sessionId: "s-1" }];
    await forwardAgentMessages("test-anthropic", {
      model: "fake-1",
      system: "Ban la chuyen gia bonsai",
      messages: [{ role: "user", content: "cay mai" }],
    });
    expect(fake.seenMessage).toBe("Ban la chuyen gia bonsai\n\nHuman: cay mai");
  });

  it("emits the full streaming envelope in order", async () => {
    fake.deleted = [];
    fake.script = [
      { type: "text", content: "Xin " },
      { type: "text", content: "chao" },
      { type: "done", sessionId: "s-1", usage: FULL_USAGE },
    ];
    const res = await forwardAgentMessages("test-anthropic", body({ stream: true }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = await sseEvents(res);
    expect(events.map(([name]) => name)).toEqual([
      "message_start", "content_block_start",
      "content_block_delta", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ]);
    const deltas = events.filter(([n]) => n === "content_block_delta").map(([, d]) => d.delta.text);
    expect(deltas.join("")).toBe("Xin chao");
    expect(events.find(([n]) => n === "message_delta")![1].usage).toEqual({ output_tokens: 7 });
    expect(fake.deleted.length).toBe(1);
  });

  it("keeps the envelope valid when the turn errors mid-stream", async () => {
    fake.script = [{ type: "text", content: "part" }, { type: "error", message: "boom" }];
    const res = await forwardAgentMessages("test-anthropic", body({ stream: true }));
    const events = await sseEvents(res);
    // A client that never sees message_stop hangs, so the envelope must close.
    expect(events.at(-1)![0]).toBe("message_stop");
    const text = events.filter(([n]) => n === "content_block_delta").map(([, d]) => d.delta.text).join("");
    expect(text).toContain("boom");
  });

  it("deletes the ephemeral session on success and on error", async () => {
    fake.deleted = [];
    fake.script = [{ type: "text", content: "ok" }, { type: "done", sessionId: "s-1" }];
    await forwardAgentMessages("test-anthropic", body());
    fake.script = [{ type: "error", message: "nope" }];
    const res = await forwardAgentMessages("test-anthropic", body());
    expect(res.status).toBe(502);
    expect(fake.deleted.length).toBe(2);
  });

  it("refuses an image instead of answering as if it had seen one", async () => {
    const res = await forwardAgentMessages("test-anthropic", {
      model: "fake-1",
      messages: [{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image" }] }],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as any;
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toContain("image blocks are not supported");
  });

  it("uses Anthropic's error envelope, not OpenAI's", async () => {
    const res = await forwardAgentMessages("nope", body());
    expect(res.status).toBe(404);
    const j = await res.json() as any;
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("not_found_error");
    expect(j.error.message).toContain("test-anthropic");
  });

  it("never exposes the internal mock provider", async () => {
    const res = await forwardAgentMessages("mock", body());
    expect(res.status).toBe(404);
    expect((await res.json() as any).error.message.split("Available: ")[1]).not.toContain("mock");
  });
});

describe("anthropic wire format", () => {
  it("drops non-text blocks but flags them", () => {
    const withImage = {
      messages: [{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image" }] }],
    };
    expect(buildPromptFromAnthropicMessages(withImage).prompt).toBe("Human: what?");
    expect(hasUnsupportedAnthropicBlocks(withImage)).toBe(true);
  });

  it("reads system given as blocks", () => {
    const r = buildPromptFromAnthropicMessages({
      system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.systemPrompt).toBe("a\nb");
  });

  it("maps status onto Anthropic error types", async () => {
    expect((await anthropicError(400, "m").json() as any).error.type).toBe("invalid_request_error");
    expect((await anthropicError(502, "m").json() as any).error.type).toBe("api_error");
  });
});
