import { describe, test, expect } from "bun:test";
import { computeCpuPercents, cpuSampleKey } from "../../../../src/services/system-metrics/process-cpu-delta.ts";

describe("computeCpuPercents", () => {
  test("no previous state → every process reads 0 (never a guess)", () => {
    const { percentByKey, next } = computeCpuPercents(null, [{ key: "1:0", cpuMs: 5000 }], 1000, 8);
    expect(percentByKey.get("1:0")).toBe(0);
    expect(next.at).toBe(1000);
    expect(next.byKey.get("1:0")).toBe(5000);
  });

  test("steady 50 % of one core on an N-core box reads 50/N", () => {
    const prev = { at: 0, byKey: new Map([["7:100", 1000]]) };
    const { percentByKey } = computeCpuPercents(prev, [{ key: "7:100", cpuMs: 2000 }], 2000, 4);
    // 1000 ms of CPU over 2000 ms wall × 4 cores = 12.5 %.
    expect(percentByKey.get("7:100")).toBe(12.5);
  });

  test("unknown key (new process) → 0 even when others have a baseline", () => {
    const prev = { at: 0, byKey: new Map([["1:0", 0]]) };
    const { percentByKey } = computeCpuPercents(prev, [{ key: "1:0", cpuMs: 500 }, { key: "2:0", cpuMs: 9999 }], 1000, 1);
    expect(percentByKey.get("1:0")).toBe(50);
    expect(percentByKey.get("2:0")).toBe(0);
  });

  test("pid reuse: same pid with a new startedAt is a new key → 0 and a fresh baseline", () => {
    const oldKey = cpuSampleKey(42, 1000);
    const newKey = cpuSampleKey(42, 5000);
    const prev = { at: 0, byKey: new Map([[oldKey, 800]]) };
    const { percentByKey, next } = computeCpuPercents(prev, [{ key: newKey, cpuMs: 10 }], 1000, 1);
    expect(percentByKey.get(newKey)).toBe(0);
    expect(next.byKey.has(oldKey)).toBe(false);
    expect(next.byKey.get(newKey)).toBe(10);
  });

  test("counter going backwards → 0 and the baseline resets to the new value", () => {
    const prev = { at: 0, byKey: new Map([["3:0", 5000]]) };
    const { percentByKey, next } = computeCpuPercents(prev, [{ key: "3:0", cpuMs: 100 }], 1000, 1);
    expect(percentByKey.get("3:0")).toBe(0);
    expect(next.byKey.get("3:0")).toBe(100);
  });

  test("dead keys are dropped so the map cannot grow unbounded", () => {
    const prev = { at: 0, byKey: new Map([["1:0", 1], ["2:0", 2], ["3:0", 3]]) };
    const { next } = computeCpuPercents(prev, [{ key: "2:0", cpuMs: 2 }], 1000, 1);
    expect([...next.byKey.keys()]).toEqual(["2:0"]);
  });

  test("percentage is capped at 100 and non-positive wall time yields 0", () => {
    const prev = { at: 1000, byKey: new Map([["1:0", 0]]) };
    expect(computeCpuPercents(prev, [{ key: "1:0", cpuMs: 99999 }], 1001, 1).percentByKey.get("1:0")).toBe(100);
    expect(computeCpuPercents(prev, [{ key: "1:0", cpuMs: 99999 }], 1000, 1).percentByKey.get("1:0")).toBe(0);
  });
});
