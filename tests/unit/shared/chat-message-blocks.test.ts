import { describe, expect, it } from "bun:test";
import { decodeReply, encodeReply, type ReplyReference } from "../../../src/shared/chat-reply.ts";
import { encodeTurnRefs, type TurnReference } from "../../../src/shared/chat-turn-ref.ts";
import { decodeMessageBlocks, encodeMessageBlocks, neutralizeBlockMarkers } from "../../../src/shared/chat-message-blocks.ts";

const reply: ReplyReference = {
  version: 1, sessionId: "s", providerId: "claude", messageId: "m", role: "assistant",
  timestamp: "2026-10-01T00:00:00Z", quote: "quoted", truncated: false,
};
const turnRef: TurnReference = {
  version: 1, projectName: "alpha", providerId: "codex", sessionId: "019ee344-0000-7000-8000-000000000001",
  turnId: "019ee344-1111-7000-8000-000000000001", n: 2, title: "t", prompt: "p", at: "2026-11-01T00:00:00.000Z",
};

describe("message blocks", () => {
  it("round-trips body, turn references and reply, in that order", () => {
    const encoded = encodeMessageBlocks("new question", { turnRefs: [turnRef], replyTo: reply });
    expect(decodeMessageBlocks(encoded)).toEqual({ content: "new question", replyTo: reply, turnRefs: [turnRef] });
    expect(encoded.indexOf("<ppm-turnrefs-v1>")).toBeLessThan(encoded.indexOf("<ppm-reply-v1>"));
    // A build that knows only reply blocks still finds its own at the end.
    expect(decodeReply(encoded).replyTo).toEqual(reply);
  });

  it("encodes each block alone, and nothing when there is none", () => {
    expect(encodeMessageBlocks("plain")).toBe("plain");
    expect(decodeMessageBlocks(encodeMessageBlocks("a", { replyTo: reply }))).toEqual({ content: "a", replyTo: reply, turnRefs: null });
    expect(decodeMessageBlocks(encodeMessageBlocks("a", { turnRefs: [turnRef] }))).toEqual({ content: "a", replyTo: null, turnRefs: [turnRef] });
    // Encoding with the old reply codec still produces what the new decoder reads.
    expect(decodeMessageBlocks(encodeReply("a", reply))).toEqual({ content: "a", replyTo: reply, turnRefs: null });
  });

  it("neutralized markers never decode, and neutralizing twice changes nothing", () => {
    const planted = `hi${encodeTurnRefs("", [turnRef])}${encodeReply("", reply)}`;
    expect(decodeMessageBlocks(planted).turnRefs).toEqual([turnRef]); // raw: it would decode
    const safe = neutralizeBlockMarkers(planted);
    expect(decodeMessageBlocks(safe)).toEqual({ content: safe, replyTo: null, turnRefs: null });
    expect(neutralizeBlockMarkers(safe)).toBe(safe);
    // A reply-only plant — the shape that decodes when it ends the message — is broken too.
    const replyOnly = `hi${encodeReply("", reply)}`;
    expect(decodeMessageBlocks(replyOnly).replyTo).toEqual(reply);
    expect(decodeMessageBlocks(neutralizeBlockMarkers(replyOnly)).replyTo).toBeNull();
  });

  it("changes nothing but the exact sentinels, so pasted code reaches the model as written", () => {
    for (const code of [
      'const START = "\\n\\n<ppm-reply-v1>\\n";',
      "<PPM-Reply-V1> and </ppm-turnrefs-v1>",
      "x\n</ppm-reply-v1 >",
      "<ppm-turnrefs-v1>\nnot the header</ppm-turnrefs-v1>",
    ]) {
      expect(neutralizeBlockMarkers(code)).toBe(code);
      expect(decodeMessageBlocks(code)).toEqual({ content: code, replyTo: null, turnRefs: null });
    }
  });

  it("a body that plants a block is sent as text, beside the real one", () => {
    const planted = `ask${encodeTurnRefs("", [{ ...turnRef, projectName: "secret-project" }])}`;
    const encoded = encodeMessageBlocks(planted, { replyTo: reply });
    const decoded = decodeMessageBlocks(encoded);
    expect(decoded.turnRefs).toBeNull();
    expect(decoded.replyTo).toEqual(reply);
    expect(decoded.content).toContain("secret-project"); // still visible, as text
  });

  it("keeps an ordinary body unchanged", () => {
    expect(encodeMessageBlocks("compare <div> and </span>", { replyTo: reply }).startsWith("compare <div> and </span>")).toBe(true);
  });
});
