// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-should-decode-access-unit.test.ts
import { describe, it, expect } from "bun:test";
import { shouldDecodeAccessUnit } from "../../../src/web/components/remote-desktop/use-h264-canvas-decoder.ts";

describe("shouldDecodeAccessUnit", () => {
  it("drops a delta access unit before any keyframe has been seen (initial connect, or right after an auto-recovered decode error)", () => {
    expect(shouldDecodeAccessUnit(false, false)).toBe(false);
  });

  it("accepts a keyframe even when no keyframe has been seen yet", () => {
    expect(shouldDecodeAccessUnit(false, true)).toBe(true);
  });

  it("accepts a delta access unit once a keyframe has already been seen", () => {
    expect(shouldDecodeAccessUnit(true, false)).toBe(true);
  });

  it("accepts a keyframe regardless of prior state", () => {
    expect(shouldDecodeAccessUnit(true, true)).toBe(true);
  });
});
