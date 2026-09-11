/**
 * Where the line between "a diff" and "a preview" is drawn.
 *
 * The rule is git's own, and the window matters: a NUL *anywhere* would call a
 * minified bundle with one stray byte binary, while no window at all means
 * scanning a 200 MB video to learn what its first 8 bytes already said.
 */
import { describe, it, expect } from "bun:test";
import { BINARY_SNIFF_BYTES, isBinaryContent } from "../../../src/services/binary-content.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("isBinaryContent", () => {
  it("leaves text alone, including the parts that are not ASCII", () => {
    expect(isBinaryContent(utf8("one\ntwo\n"))).toBe(false);
    expect(isBinaryContent(utf8("Tiếng Việt — “curly”, 🎉\n"))).toBe(false);
    expect(isBinaryContent(utf8(""))).toBe(false);
  });

  it("catches a PNG by the NULs in its very first chunk", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(isBinaryContent(png)).toBe(true);
  });

  it("only looks at the first 8000 bytes, the way git does", () => {
    const late = new Uint8Array(BINARY_SNIFF_BYTES + 1000).fill(0x61);
    late[BINARY_SNIFF_BYTES + 500] = 0x00;
    expect(isBinaryContent(late)).toBe(false);

    const edge = new Uint8Array(BINARY_SNIFF_BYTES + 1000).fill(0x61);
    edge[BINARY_SNIFF_BYTES - 1] = 0x00;
    expect(isBinaryContent(edge)).toBe(true);
  });

  it("does not call a side that does not exist binary", () => {
    // An added file has no version at HEAD. If that counted, every new text
    // file would open as a preview instead of a diff.
    expect(isBinaryContent(null)).toBe(false);
    expect(isBinaryContent(undefined)).toBe(false);
  });
});
