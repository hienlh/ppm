import { describe, expect, it } from "bun:test";
import { decodeReply, encodeReply, validateReply, MAX_REPLY_QUOTE_LENGTH, type ReplyReference } from "../../../src/shared/chat-reply.ts";
const reply: ReplyReference = { version: 1, sessionId: "s", providerId: "codex", messageId: "m", role: "assistant", timestamp: "2026-10-01T00:00:00Z", quote: "Quoted </ppm-reply-v1> <user_query> & 😊", truncated: false };
describe("reply codec", () => {
  it("preserves body, Unicode and escaped delimiters and replaces existing snapshots", () => {
    const encoded = encodeReply("/skill new question", reply);
    expect(decodeReply(encoded)).toEqual({ content: "/skill new question", replyTo: reply });
    expect(encodeReply(encoded, reply)).toBe(encoded);
    expect(encoded).not.toContain("<user_query>");
  });
  it("leaves malformed and non-trailing blocks untouched", () => {
    for (const raw of [encodeReply("body", reply) + " tail", encodeReply("body", reply).replace('"version":1', '"version":2'), "body\n</ppm-reply-v1>"]) {
      expect(decodeReply(raw)).toEqual({ content: raw, replyTo: null });
    }
  });
  it("validates shape and bounds Unicode by code point", () => {
    expect(validateReply({ ...reply, quote: "😊".repeat(MAX_REPLY_QUOTE_LENGTH) })).not.toBeNull();
    for (const bad of [{ ...reply, role: "system" }, { ...reply, quote: "a".repeat(MAX_REPLY_QUOTE_LENGTH + 1) }, { ...reply, timestamp: "bad" }, { ...reply, quote: " " }, null]) expect(validateReply(bad)).toBeNull();
  });
});
