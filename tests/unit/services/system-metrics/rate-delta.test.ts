import { describe, test, expect } from "bun:test";
import { toRate, type CounterSample } from "../../../../src/services/system-metrics/rate-delta.ts";

const sample = (inBytes: number, outBytes: number, atSec: number): CounterSample => ({ inBytes, outBytes, atSec });

describe("toRate", () => {
  test("first sample has no baseline → unavailable", () => {
    expect(toRate(null, sample(100, 200, 10))).toEqual({ inBps: 0, outBps: 0, available: false });
  });

  test("steady counters → integer bytes/sec over the counter's own clock", () => {
    const r = toRate(sample(1000, 2000, 10), sample(3000, 2500, 12));
    expect(r).toEqual({ inBps: 1000, outBps: 250, available: true });
  });

  test("zero or negative interval → unavailable", () => {
    expect(toRate(sample(0, 0, 10), sample(100, 100, 10)).available).toBe(false);
    expect(toRate(sample(0, 0, 10), sample(100, 100, 9)).available).toBe(false);
  });

  test("uint32 wrap is corrected instead of blanking the chart", () => {
    // 32-bit BytesReceivedPersec wraps every ~34 s of sustained gigabit.
    const prev = sample(2 ** 32 - 1000, 0, 100);
    const next = sample(500, 0, 101);
    expect(toRate(prev, next)).toEqual({ inBps: 1500, outBps: 0, available: true });
  });

  test("a backwards counter whose corrected rate is implausible → unavailable (counter reset)", () => {
    // Drop of 200 GB in one second is not a wrap — it is a reset.
    const prev = sample(300 * 1024 ** 3, 0, 100);
    const next = sample(100 * 1024 ** 3, 0, 101);
    expect(toRate(prev, next).available).toBe(false);
  });

  test("non-finite input → unavailable", () => {
    expect(toRate(sample(0, 0, 1), sample(Number.NaN, 0, 2)).available).toBe(false);
  });
});
