import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBookmarkPath, BookmarkDecodeError } from "../../../../src/services/host-info/apple-bookmark-decoder.ts";

const fixtureB64 = readFileSync(
  join(import.meta.dir, "../../../fixtures/host-info/bookmark-blob.base64"),
  "utf-8",
).trim();

describe("decodeBookmarkPath", () => {
  test("decodes the fixture blob into /Users/victor/Documents", () => {
    const buf = Buffer.from(fixtureB64, "base64");
    expect(decodeBookmarkPath(buf)).toBe("/Users/victor/Documents");
  });

  test("rejects a buffer missing the 'book' magic header", () => {
    const buf = Buffer.alloc(60);
    buf.write("nope", 0, "ascii");
    expect(() => decodeBookmarkPath(buf)).toThrow(BookmarkDecodeError);
  });

  test("rejects a buffer too short to hold a header", () => {
    expect(() => decodeBookmarkPath(Buffer.alloc(10))).toThrow(BookmarkDecodeError);
  });

  test("rejects a TOC with the wrong magic number", () => {
    const buf = Buffer.from(fixtureB64, "base64");
    const corrupted = Buffer.from(buf); // copy — never mutate the shared fixture buffer
    const tocOffset = corrupted.readUInt32LE(48);
    corrupted.writeUInt32LE(0x11111111, tocOffset + 4); // stomp the TOC magic
    expect(() => decodeBookmarkPath(corrupted)).toThrow(BookmarkDecodeError);
  });

  test("rejects a TOC missing the kBookmarkPath (0x1004) entry", () => {
    const buf = Buffer.from(fixtureB64, "base64");
    const corrupted = Buffer.from(buf);
    const tocOffset = corrupted.readUInt32LE(48);
    corrupted.writeUInt32LE(0x9999, tocOffset + 20); // stomp the single entry's key
    expect(() => decodeBookmarkPath(corrupted)).toThrow(BookmarkDecodeError);
  });
});
