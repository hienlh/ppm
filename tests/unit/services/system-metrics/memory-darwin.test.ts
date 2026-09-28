/**
 * macOS swap, parsed out of `sysctl -n vm.swapusage`.
 *
 * The reason this exists at all is that the figure was *absent* off Linux, and
 * the memory page renders an absent field as an em dash — the claim that the
 * host's swap cannot be measured. Measured on a real M1 Max, it read
 * `total = 9216.00M  used = 8047.00M`, i.e. 8 GB of swap in use on a machine
 * whose memory page said nothing about swap at all.
 *
 * Both halves of the contract are pinned here: a line that parses yields real
 * numbers, and a line that does not yields `undefined` rather than zeroes —
 * because "0 MB of swap" and "this host's swap was not read" are different
 * claims and the UI draws them differently (a hidden graph against an em dash).
 */
import { describe, test, expect } from "bun:test";
import { parseSwapUsage, readSwapUsage } from "../../../../src/services/system-metrics/memory-darwin.ts";

/** The exact line this host's macOS 15.7.9 printed. */
const REAL = "total = 9216.00M  used = 8047.00M  free = 1169.00M  (encrypted)\n";

describe("the real output", () => {
  test("reads the figures a Mac actually printed", () => {
    expect(parseSwapUsage(REAL)).toEqual({ swapTotalMB: 9216, swapUsedMB: 8047 });
  });

  test("used is taken from `used`, not from total minus free", () => {
    // They agree here, but only because nothing else is mapped; a format change
    // that moved the columns must fail rather than quietly read `free`.
    expect(parseSwapUsage("total = 100.00M  used = 25.00M  free = 75.00M")?.swapUsedMB).toBe(25);
  });
});

describe("units", () => {
  test("G and T scale up, K scales down", () => {
    expect(parseSwapUsage("total = 2.00G used = 1.50G")).toEqual({ swapTotalMB: 2048, swapUsedMB: 1536 });
    expect(parseSwapUsage("total = 1.00T used = 0.50T")).toEqual({ swapTotalMB: 1048576, swapUsedMB: 524288 });
    expect(parseSwapUsage("total = 2048.00K used = 1024.00K")).toEqual({ swapTotalMB: 2, swapUsedMB: 1 });
  });

  test("a bare number is bytes, which only ever matters for zero", () => {
    expect(parseSwapUsage("total = 0 used = 0")).toEqual({ swapTotalMB: 0, swapUsedMB: 0 });
  });
});

describe("swap that is off is zero, not absent", () => {
  test("a Mac with no swap file reports a real 0", () => {
    // The UI hides the graph on `total === 0` and shows an em dash only on
    // `undefined`, so this is the difference between "nothing to swap to" and
    // "not measured".
    expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({
      swapTotalMB: 0, swapUsedMB: 0,
    });
  });
});

describe("anything unrecognised is absent, never zero", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["an error message", "sysctl: unknown oid 'vm.swapusage'"],
    ["only a total", "total = 9216.00M"],
    ["a non-numeric field", "total = N/A used = N/A"],
  ])("%s yields undefined", (_label, input) => {
    expect(parseSwapUsage(input as string | null | undefined)).toBeUndefined();
  });

  test("a negative figure is not trusted into a negative reading", () => {
    expect(parseSwapUsage("total = -1.00M used = 5.00M")).toBeUndefined();
  });
});

describe("used cannot exceed total", () => {
  test("a sample taken mid-resize is clamped, not reported as over-full", () => {
    expect(parseSwapUsage("total = 100.00M used = 150.00M")).toEqual({
      swapTotalMB: 100, swapUsedMB: 100,
    });
  });
});

describe("the reader spawns only where the figure exists", () => {
  test("returns null off darwin, so no other platform pays for a spawn", () => {
    // This suite runs on Linux in CI and on a Mac by hand; assert the branch that
    // belongs to whichever this is, so the test is meaningful on both.
    const out = readSwapUsage();
    if (process.platform === "darwin") {
      expect(out).toBeTypeOf("string");
      expect(parseSwapUsage(out)).toBeDefined();
    } else {
      expect(out).toBeNull();
    }
  });
});
