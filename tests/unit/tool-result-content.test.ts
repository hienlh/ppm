import { describe, test, expect } from "bun:test";
import {
  stringifyToolResultContent,
  resultHasImagePlaceholder,
} from "../../src/shared/tool-result-content.ts";

/** base64 for `size` bytes of padding-free payload (length is a multiple of 4). */
function base64OfBytes(size: number): string {
  return Buffer.alloc(size, 0x61).toString("base64");
}

const imageBlock = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

describe("stringifyToolResultContent", () => {
  test("returns a string unchanged", () => {
    expect(stringifyToolResultContent("plain output")).toBe("plain output");
  });

  test("array without an image block is byte-identical to JSON.stringify", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(stringifyToolResultContent(content)).toBe(JSON.stringify(content));
  });

  test("replaces an image block and drops the base64", () => {
    const data = base64OfBytes(240 * 1024);
    const out = stringifyToolResultContent([imageBlock(data)]);

    expect(out).toContain("[image · 240KB]");
    expect(out).not.toContain(data);
    expect(out).not.toContain(data.slice(0, 64));
  });

  test("keeps the block-array shape so consumers can still parse it", () => {
    const out = stringifyToolResultContent([
      { type: "text", text: "before" },
      imageBlock(base64OfBytes(2048)),
    ]);
    expect(JSON.parse(out)).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "[image · 2KB]" },
    ]);
  });

  test("each image block gets its own placeholder", () => {
    const out = stringifyToolResultContent([
      imageBlock(base64OfBytes(1024)),
      imageBlock(base64OfBytes(3072)),
    ]);
    expect(JSON.parse(out)).toEqual([
      { type: "text", text: "[image · 1KB]" },
      { type: "text", text: "[image · 3KB]" },
    ]);
  });

  test("formats byte and megabyte sizes", () => {
    const small = stringifyToolResultContent([imageBlock(base64OfBytes(300))]);
    expect(small).toContain("[image · 300B]");

    const large = stringifyToolResultContent([imageBlock(base64OfBytes(3 * 1024 * 1024))]);
    expect(large).toContain("[image · 3.0MB]");
  });

  test("accounts for base64 padding when computing size", () => {
    // 1025 bytes encodes with a single '=' pad; without adjusting, size would read high.
    const padded = Buffer.alloc(1025, 0x61).toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    const out = stringifyToolResultContent([imageBlock(padded)]);
    expect(JSON.parse(out)).toEqual([{ type: "text", text: "[image · 1KB]" }]);
  });

  test("malformed image block degrades to a bare placeholder", () => {
    expect(JSON.parse(stringifyToolResultContent([{ type: "image" }]))).toEqual([
      { type: "text", text: "[image]" },
    ]);
    expect(
      JSON.parse(stringifyToolResultContent([{ type: "image", source: { data: "" } }])),
    ).toEqual([{ type: "text", text: "[image]" }]);
  });

  test("does not throw on non-array, non-string input", () => {
    expect(stringifyToolResultContent(undefined)).toBe("");
    expect(stringifyToolResultContent(null)).toBe("null");
    expect(stringifyToolResultContent(42)).toBe("42");
    expect(stringifyToolResultContent({ ok: true })).toBe('{"ok":true}');
  });

  test("tolerates null entries inside the block array", () => {
    expect(() => stringifyToolResultContent([null, imageBlock(base64OfBytes(4))])).not.toThrow();
  });
});

describe("resultHasImagePlaceholder", () => {
  test("detects output this module produced for an image", () => {
    const out = stringifyToolResultContent([imageBlock(base64OfBytes(4096))]);
    expect(resultHasImagePlaceholder(out)).toBe(true);
  });

  test("detects a sizeless placeholder from a malformed image block", () => {
    const out = stringifyToolResultContent([{ type: "image" }]);
    expect(resultHasImagePlaceholder(out)).toBe(true);
  });

  // An SVG read comes back as text, so its content must stay visible in the card.
  test("returns false for a text-only result", () => {
    const out = stringifyToolResultContent([{ type: "text", text: "<svg></svg>" }]);
    expect(resultHasImagePlaceholder(out)).toBe(false);
  });

  test("returns false for plain string output and non-JSON", () => {
    expect(resultHasImagePlaceholder("read 40 lines")).toBe(false);
    expect(resultHasImagePlaceholder("")).toBe(false);
    expect(resultHasImagePlaceholder("[not json")).toBe(false);
  });

  // A file whose text merely mentions the marker must not suppress its own content:
  // the whole text block has to be exactly the placeholder.
  test("requires the entire text block to be the placeholder", () => {
    const mentions = JSON.stringify([
      { type: "text", text: "the log said [image · 12KB] was cached" },
    ]);
    expect(resultHasImagePlaceholder(mentions)).toBe(false);
  });
});
