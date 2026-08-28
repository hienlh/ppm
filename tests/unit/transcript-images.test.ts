import { describe, test, expect } from "bun:test";
import {
  auditTranscriptImages,
  stripTranscriptImages,
  MANY_IMAGE_DIMENSION_LIMIT,
} from "../../src/services/transcript-images.ts";
import { resultHasImagePlaceholder } from "../../src/shared/tool-result-content.ts";

/** A buffer with a valid PNG header of the given size; the pixel data is irrelevant here. */
function pngBase64(w: number, h: number, padBytes = 0): string {
  const buf = Buffer.alloc(24 + padBytes);
  buf.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf.toString("base64");
}

function jpegBase64(w: number, h: number): string {
  const buf = Buffer.alloc(11);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xc0;
  buf.writeUInt16BE(0x0011, 4);
  buf[6] = 8;
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  return buf.toString("base64");
}

function gifBase64(w: number, h: number): string {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf.toString("base64");
}

const imageBlock = (data: string, media = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type: media, data },
});

/** One JSONL line holding a tool result whose content carries the given blocks. */
function toolResultLine(blocks: unknown[], toolUseId = "t1"): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${toolUseId}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: blocks }] },
  });
}

/** A user message with an attached image — must never be touched. */
function userAttachmentLine(data: string): string {
  return JSON.stringify({
    type: "user",
    uuid: "u-att",
    message: { role: "user", content: [{ type: "text", text: "look" }, imageBlock(data)] },
  });
}

describe("auditTranscriptImages", () => {
  test("counts tool-result images with their decoded size and longest side", () => {
    const text = [
      toolResultLine([imageBlock(pngBase64(800, 600, 300))]),
      toolResultLine([imageBlock(pngBase64(2400, 1530, 600))], "t2"),
    ].join("\n");

    const audit = auditTranscriptImages(text);
    expect(audit.total).toBe(2);
    expect(audit.oversized).toBe(1);
    expect(audit.largestSide).toBe(2400);
    expect(audit.bytes).toBeGreaterThan(0);
    expect(audit.oversizedBytes).toBeGreaterThan(0);
    expect(audit.oversizedBytes).toBeLessThan(audit.bytes);
  });

  test("reads dimensions from jpeg and gif headers too", () => {
    const text = [
      toolResultLine([imageBlock(jpegBase64(3000, 100), "image/jpeg")]),
      toolResultLine([imageBlock(gifBase64(2200, 50), "image/gif")], "t2"),
    ].join("\n");
    const audit = auditTranscriptImages(text);
    expect(audit.total).toBe(2);
    expect(audit.oversized).toBe(2);
    expect(audit.largestSide).toBe(3000);
  });

  test("the cap is a strict upper bound", () => {
    const at = auditTranscriptImages(toolResultLine([imageBlock(pngBase64(MANY_IMAGE_DIMENSION_LIMIT, 10))]));
    expect(at.oversized).toBe(0);
    const over = auditTranscriptImages(toolResultLine([imageBlock(pngBase64(MANY_IMAGE_DIMENSION_LIMIT + 1, 10))]));
    expect(over.oversized).toBe(1);
  });

  // An attachment may not exist anywhere else, so it is outside this feature's remit.
  test("ignores images the user attached to a message", () => {
    const audit = auditTranscriptImages(userAttachmentLine(pngBase64(4000, 3000)));
    expect(audit.total).toBe(0);
  });

  test("survives malformed lines and empty input", () => {
    expect(auditTranscriptImages("").total).toBe(0);
    expect(auditTranscriptImages("not json\n{}\n").total).toBe(0);
  });
});

describe("stripTranscriptImages", () => {
  const mixed = [
    toolResultLine([imageBlock(pngBase64(800, 600, 400))], "small"),
    toolResultLine([imageBlock(pngBase64(2400, 1530, 400))], "big"),
    userAttachmentLine(pngBase64(4000, 3000)),
  ].join("\n");

  test("oversized mode removes only what exceeds the cap", () => {
    const out = stripTranscriptImages(mixed, "oversized");
    expect(out.removed).toBe(1);
    expect(out.bytesFreed).toBeGreaterThan(0);

    const after = auditTranscriptImages(out.text);
    expect(after.total).toBe(1);
    expect(after.oversized).toBe(0);
  });

  test("all mode removes every tool-result image but keeps the attachment", () => {
    const out = stripTranscriptImages(mixed, "all");
    expect(out.removed).toBe(2);
    expect(auditTranscriptImages(out.text).total).toBe(0);
    // The attachment line is still present, image and all.
    expect(out.text.includes(pngBase64(4000, 3000))).toBe(true);
  });

  test("record count and line order are preserved", () => {
    const out = stripTranscriptImages(mixed, "all");
    expect(out.text.split("\n").length).toBe(mixed.split("\n").length);
    for (const line of out.text.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("a trailing newline is preserved", () => {
    const withNewline = `${toolResultLine([imageBlock(pngBase64(2400, 100))])}\n`;
    const out = stripTranscriptImages(withNewline, "all");
    expect(out.text.endsWith("\n")).toBe(true);
    expect(out.text.split("\n").length).toBe(withNewline.split("\n").length);
  });

  test("a line that does not parse is returned byte-for-byte", () => {
    const text = `garbage {not json\n${toolResultLine([imageBlock(pngBase64(2400, 100))])}`;
    const out = stripTranscriptImages(text, "all");
    expect(out.text.split("\n")[0]).toBe("garbage {not json");
    expect(out.removed).toBe(1);
  });

  test("an image whose dimensions cannot be read is left alone in oversized mode", () => {
    const text = toolResultLine([imageBlock(Buffer.from("nonsense payload").toString("base64"), "image/tiff")]);
    const out = stripTranscriptImages(text, "oversized");
    expect(out.removed).toBe(0);
    // ...but `all` still clears it, since that mode is about reclaiming space.
    expect(stripTranscriptImages(text, "all").removed).toBe(1);
  });

  test("nothing to do leaves the text identical", () => {
    const text = toolResultLine([{ type: "text", text: "plain" }]);
    const out = stripTranscriptImages(text, "all");
    expect(out.text).toBe(text);
    expect(out.removed).toBe(0);
  });

  // The chat card hides a tool result's text when it recognises this placeholder, so a
  // stripped transcript must keep rendering exactly like a fresh read.
  test("the placeholder it writes is the one the chat UI recognises", () => {
    const out = stripTranscriptImages(toolResultLine([imageBlock(pngBase64(2400, 100, 5000))]), "all");
    const record = JSON.parse(out.text);
    const output = JSON.stringify(record.message.content[0].content);
    expect(resultHasImagePlaceholder(output)).toBe(true);
  });
});
