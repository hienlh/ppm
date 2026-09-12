/**
 * The agent→OpenAI bridge behind `/proxy/v1/<provider>/chat/completions`.
 * Drives a fake provider registered into the real registry, so the assertions
 * cover the bridge's own contract: prompt flattening, wire format, usage
 * mapping, and the ephemeral-session guarantee an API caller depends on.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { forwardAgentChatCompletions, listProviderModels } from "../../../src/services/proxy-agent-bridge.ts";
import type { AIProvider, ChatEvent, Session } from "../../../src/types/chat.ts";

const FULL_USAGE = {
  model: "fake-1", inputTokens: 10, outputTokens: 7, cacheReadTokens: 5,
  cacheWriteTokens: 3, contextWindow: 200_000, costUsd: 0.01,
  cacheHitRate: 0.5, coldStart: false,
};

/** Records what the bridge asked for and replays a scripted event stream. */
class FakeProvider implements AIProvider {
  name = "Fake";
  script: ChatEvent[] = [];
  seenMessage = "";
  seenModel: string | undefined;
  seenPermissionMode: string | undefined;
  created = 0;
  deleted: string[] = [];

  constructor(readonly id: string) {}

  async createSession(): Promise<Session> {
    this.created++;
    return { id: `s-${this.created}`, providerId: this.id, title: "t", createdAt: new Date().toISOString() } as Session;
  }
  async resumeSession(): Promise<Session> { throw new Error("unused"); }
  async listSessions() { return []; }
  async deleteSession(id: string) { this.deleted.push(id); }
  async listModels() { return [{ value: "fake-1", label: "Fake One" }]; }

  /** When true the stream never ends, the way a real live session behaves. */
  endless = false;

  async *sendMessage(_id: string, message: string, opts?: { model?: string; permissionMode?: string }): AsyncIterable<ChatEvent> {
    this.seenMessage = message;
    this.seenModel = opts?.model;
    this.seenPermissionMode = opts?.permissionMode;
    for (const ev of this.script) yield ev;
    if (this.endless) await new Promise(() => {});
  }
}

const fake = new FakeProvider("test-agent");
beforeAll(() => { providerRegistry.register(fake); });

const body = (extra: Record<string, unknown> = {}) => ({
  model: "fake-1",
  messages: [{ role: "user", content: "xin chao" }],
  ...extra,
});

/** Collect an SSE body into its decoded `data:` payloads. */
async function sseFrames(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

describe("proxy agent bridge", () => {
  it("maps assistant text and provider usage onto a chat.completion", async () => {
    fake.script = [
      { type: "thinking", content: "ignored" },
      { type: "text", content: "Xin " },
      { type: "tool_use", tool: "Bash", input: {} },
      { type: "text", content: "chao!" },
      { type: "done", sessionId: "s-1", usage: FULL_USAGE },
    ];
    const res = await forwardAgentChatCompletions("test-agent", body());
    expect(res.status).toBe(200);
    const j = await res.json() as any;

    expect(j.object).toBe("chat.completion");
    // Only assistant text reaches the caller — thinking and tool traffic do not.
    expect(j.choices[0].message.content).toBe("Xin chao!");
    expect(j.choices[0].finish_reason).toBe("stop");
    expect(j.model).toBe("fake-1");
    // prompt_tokens is the whole replayed prefix, cached parts included.
    expect(j.usage).toEqual({ prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 });
  });

  it("passes the requested model through and forces a read-only agent", async () => {
    fake.script = [{ type: "text", content: "ok" }, { type: "done", sessionId: "s-1" }];
    await forwardAgentChatCompletions("test-agent", body({ model: "gpt-5.5" }));
    expect(fake.seenModel).toBe("gpt-5.5");
    expect(fake.seenPermissionMode).toBe("plan");
  });

  it("folds the system message into the turn ahead of the conversation", async () => {
    fake.script = [{ type: "text", content: "ok" }, { type: "done", sessionId: "s-1" }];
    await forwardAgentChatCompletions("test-agent", {
      model: "fake-1",
      messages: [
        { role: "system", content: "Ban la chuyen gia bonsai" },
        { role: "user", content: "cay mai" },
        { role: "assistant", content: "vang" },
      ],
    });
    expect(fake.seenMessage).toBe("Ban la chuyen gia bonsai\n\nHuman: cay mai\n\nAssistant: vang");
  });

  it("deletes the session on success — an API call leaves no conversation behind", async () => {
    fake.deleted = [];
    fake.script = [{ type: "text", content: "ok" }, { type: "done", sessionId: "s-1" }];
    await forwardAgentChatCompletions("test-agent", body());
    expect(fake.deleted.length).toBe(1);
  });

  it("deletes the session when the turn errors too", async () => {
    fake.deleted = [];
    fake.script = [{ type: "error", message: "agent exploded" }];
    const res = await forwardAgentChatCompletions("test-agent", body());
    expect(res.status).toBe(502);
    expect((await res.json() as any).error.message).toBe("agent exploded");
    expect(fake.deleted.length).toBe(1);
  });

  it("streams text as chat.completion.chunk frames ending in [DONE]", async () => {
    fake.deleted = [];
    fake.script = [
      { type: "text", content: "Xin " },
      { type: "text", content: "chao" },
      { type: "done", sessionId: "s-1" },
    ];
    const res = await forwardAgentChatCompletions("test-agent", body({ stream: true }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const frames = await sseFrames(res);
    expect(frames.at(-1)).toBe("[DONE]");
    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f));
    expect(parsed[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(parsed.map((p) => p.choices[0].delta.content ?? "").join("")).toBe("Xin chao");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
    expect(fake.deleted.length).toBe(1);
  });

  it("reports a mid-stream error inside the stream, not as a dead connection", async () => {
    fake.script = [{ type: "text", content: "part" }, { type: "error", message: "boom" }];
    const res = await forwardAgentChatCompletions("test-agent", body({ stream: true }));
    const frames = await sseFrames(res);
    const joined = frames.slice(0, -1).map((f) => JSON.parse(f).choices[0].delta.content ?? "").join("");
    expect(joined).toContain("part");
    expect(joined).toContain("boom");
    expect(frames.at(-1)).toBe("[DONE]");
  });

  it("returns as soon as the turn is done, even though the stream stays open", async () => {
    // A live provider keeps its event channel open for the next turn, so it never
    // completes on its own. The other cases end the script right after `done`,
    // which hides that; only a stream that outlives the turn proves the bridge
    // stops on `done` instead of hanging on an answer it already has.
    fake.endless = true;
    fake.script = [
      { type: "text", content: "done-and-dusted" },
      { type: "done", sessionId: "s-1", usage: FULL_USAGE },
    ];
    const res = await Promise.race([
      forwardAgentChatCompletions("test-agent", body()),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("bridge hung past the turn")), 1000)),
    ]);
    fake.endless = false;
    expect(res.status).toBe(200);
    expect((await res.json() as any).choices[0].message.content).toBe("done-and-dusted");
  });

  it("rejects an unknown provider and names the ones that work", async () => {
    const res = await forwardAgentChatCompletions("nope", body());
    expect(res.status).toBe(404);
    const msg = (await res.json() as any).error.message;
    expect(msg).toContain('Unknown provider "nope"');
    expect(msg).toContain("test-agent");
  });

  it("never exposes the internal mock provider over HTTP", async () => {
    expect(providerRegistry.get("mock")).toBeDefined();
    const res = await forwardAgentChatCompletions("mock", body());
    expect(res.status).toBe(404);
    // The message echoes what was asked for, but must not advertise mock as usable.
    const available = (await res.json() as any).error.message.split("Available: ")[1];
    expect(available).not.toContain("mock");
  });

  it("refuses an image instead of answering as if it had seen one", async () => {
    const res = await forwardAgentChatCompletions("test-agent", {
      model: "fake-1",
      messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url" }] }],
    } as any);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.message).toContain("image_url is not supported");
  });

  it("rejects a request with nothing for the agent to answer", async () => {
    const res = await forwardAgentChatCompletions("test-agent", {
      model: "fake-1", messages: [{ role: "system", content: "only a system prompt" }],
    });
    expect(res.status).toBe(502);
    expect((await res.json() as any).error.message).toContain("non-system message");
  });

  it("lists provider models in OpenAI list shape", async () => {
    const res = await listProviderModels("test-agent");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: "list",
      data: [{ id: "fake-1", object: "model", owned_by: "test-agent" }],
    });
  });

  it("404s models for an unknown provider", async () => {
    expect((await listProviderModels("nope")).status).toBe(404);
  });
});
