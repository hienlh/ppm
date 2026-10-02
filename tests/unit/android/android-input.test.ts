import { describe, expect, test } from "bun:test";
import { MAX_TOUCH_POINTS, isInjectableAscii } from "../../../src/services/android/android-input.ts";

/**
 * Phase 0 measured that `sendKey.text` carries printable ASCII and silently drops everything
 * else — `"café"` arrives as `"caf"`. These cases are the routing decision that follows from it:
 * anything this returns false for MUST go through the clipboard instead.
 */
describe("which text can be typed", () => {
  test("printable ASCII can", () => {
    expect(isInjectableAscii("hello world")).toBe(true);
    expect(isInjectableAscii("Password123!@#$%^&*()_+-=[]{}|;':\",./<>?")).toBe(true);
    expect(isInjectableAscii(" ")).toBe(true);
    expect(isInjectableAscii("")).toBe(true);
  });

  test("Vietnamese, CJK and emoji cannot", () => {
    expect(isInjectableAscii("Tiếng Việt")).toBe(false);
    expect(isInjectableAscii("café")).toBe(false);
    expect(isInjectableAscii("日本語")).toBe(false);
    expect(isInjectableAscii("😀")).toBe(false);
    // One bad character in an otherwise ASCII string still has to take the clipboard path, or
    // that character vanishes with no error.
    expect(isInjectableAscii("hello café")).toBe(false);
  });

  test("control characters cannot — including the newline a textarea produces", () => {
    expect(isInjectableAscii("\n")).toBe(false);
    expect(isInjectableAscii("a\tb")).toBe(false);
    expect(isInjectableAscii("\x7f")).toBe(false);
  });

  test("the emulator's contact limit is what the touch path clamps to", () => {
    expect(MAX_TOUCH_POINTS).toBe(10);
  });
});
