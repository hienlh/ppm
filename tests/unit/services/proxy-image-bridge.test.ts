/**
 * The OpenAI Images endpoints. The generation path itself needs a real agent, so
 * these cover what can be decided before one runs: which providers are allowed,
 * what a malformed request gets back, and the payload decoding the bridge writes
 * to disk.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { providerRegistry } from "../../../src/providers/registry.ts";
import {
  forwardImageGeneration, forwardImageEdit, decodeImagePayload,
} from "../../../src/services/proxy-image-bridge.ts";
import type { AIProvider, ChatEvent, Session } from "../../../src/types/chat.ts";

/** 1x1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class TextOnlyProvider implements AIProvider {
  name = "Text Only";
  constructor(readonly id: string) {}
  async createSession(): Promise<Session> {
    return { id: "s-1", providerId: this.id, title: "t", createdAt: new Date().toISOString() } as Session;
  }
  async resumeSession(): Promise<Session> { throw new Error("unused"); }
  async listSessions() { return []; }
  async deleteSession() {}
  async *sendMessage(): AsyncIterable<ChatEvent> {}
}

beforeAll(() => {
  providerRegistry.register(new TextOnlyProvider("test-textonly"));
  // Payload validation sits behind the capability check, so reaching it needs an
  // image-capable id. Unit tests never run bootstrapProviders, so the real codex
  // provider is absent and this fills an empty slot rather than shadowing one.
  providerRegistry.register(new TextOnlyProvider("codex"));
});

describe("proxy image bridge", () => {
  it("decodes a data URL and picks the extension from its mime type", () => {
    const png = decodeImagePayload(`data:image/png;base64,${PNG_B64}`);
    expect(png.ext).toBe(".png");
    // Round trip proves the bytes that reach disk are the caller's, not a re-encode.
    expect(png.bytes.toString("base64")).toBe(PNG_B64);
    expect(decodeImagePayload("data:image/jpeg;base64,AAAA").ext).toBe(".jpg");
    expect(decodeImagePayload("data:image/webp;base64,AAAA").ext).toBe(".webp");
  });

  it("accepts bare base64 without a data URL wrapper", () => {
    expect(decodeImagePayload(PNG_B64).bytes.toString("base64")).toBe(PNG_B64);
  });

  it("refuses a provider whose agent cannot make images", async () => {
    const res = await forwardImageGeneration("test-textonly", { prompt: "a cat" });
    expect(res.status).toBe(400);
    const msg = (await res.json() as any).error.message;
    expect(msg).toContain("cannot generate images");
    // Naming what does work saves the caller a round of guessing.
    expect(msg).toContain("codex");
  });

  it("404s an unknown provider", async () => {
    expect((await forwardImageGeneration("nosuch", { prompt: "a cat" })).status).toBe(404);
    expect((await forwardImageEdit("nosuch", { prompt: "x", image: PNG_B64 })).status).toBe(404);
  });

  it("requires a prompt on generation", async () => {
    const res = await forwardImageGeneration("codex", {});
    expect(res.status).toBe(400);
  });

  it("requires both prompt and image on edit", async () => {
    const noImage = await forwardImageEdit("codex", { prompt: "make it blue" });
    expect(noImage.status).toBe(400);
    expect((await noImage.json() as any).error.message).toContain("image is required");

    const noPrompt = await forwardImageEdit("codex", { image: PNG_B64 });
    expect(noPrompt.status).toBe(400);
    expect((await noPrompt.json() as any).error.message).toContain("prompt is required");
  });

  it("checks the provider before the payload, so an unknown provider is not a 400", async () => {
    // Order matters: a caller pointed at the wrong provider should hear that,
    // not a complaint about the body they sent correctly.
    const res = await forwardImageEdit("nosuch", {});
    expect(res.status).toBe(404);
  });
});
