/** CoreFoundation references cross bun:ffi as bigints, so a tagged pointer survives. */
import { describe, expect, test } from "bun:test";
import { darwinCoreFoundation } from "../../../../src/services/system-metrics/core-foundation-darwin.ts";

describe.if(process.platform === "darwin")("darwinCoreFoundation on this Mac", () => {
  const cf = darwinCoreFoundation()!;

  test("a short string is a tagged pointer above 2^53, and still round-trips", () => {
    const ref = cf.string("CPU Stats");
    // The value a `ptr` return would have rounded into a different pointer.
    expect(ref > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(cf.text(ref)).toBe("CPU Stats");
    cf.release(ref);
  });

  test("heap strings and non-ASCII text round-trip too", () => {
    for (const value of ["GPU Performance States", "NAND CH0 temp", "Tiếng Việt ✓"]) {
      const ref = cf.string(value);
      expect(cf.text(ref)).toBe(value);
      cf.release(ref);
    }
  });

  test("NULL is no text, and releasing it is not a crash", () => {
    expect(cf.text(0n)).toBeUndefined();
    expect(() => cf.release(0n)).not.toThrow();
  });

  test("text too long to read back whole is undefined rather than cut", () => {
    const ref = cf.string("x".repeat(4096));
    expect(cf.text(ref)).toBeUndefined();
    cf.release(ref);
  });
});

test.if(process.platform !== "darwin")("off darwin there is no CoreFoundation", () => {
  expect(darwinCoreFoundation()).toBeNull();
});
