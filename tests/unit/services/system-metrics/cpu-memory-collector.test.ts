import { describe, test, expect } from "bun:test";
import os from "node:os";
import {
  computeCpuFromSamples,
  sampleCpuTimes,
  collectMemory,
  parseMemAvailableBytes,
  type CpuTimesSample,
} from "../../../../src/services/system-metrics/cpu-memory-collector.ts";

const times = (user: number, sys: number, idle: number) => ({ user, nice: 0, sys, idle, irq: 0 });
const sample = (at: number, ...cores: ReturnType<typeof times>[]): CpuTimesSample => ({ times: cores, at, model: "test" });

describe("computeCpuFromSamples", () => {
  test("no previous sample → zeros with the right core count", () => {
    const r = computeCpuFromSamples(null, sample(0, times(1, 1, 1), times(1, 1, 1)));
    expect(r).toEqual({ total: 0, cores: [0, 0], model: "test" });
  });

  test("busy fraction per core and machine total", () => {
    const prev = sample(0, times(0, 0, 0), times(0, 0, 0));
    const next = sample(1000, times(500, 0, 500), times(0, 250, 750));
    const r = computeCpuFromSamples(prev, next);
    expect(r.cores).toEqual([50, 25]);
    expect(r.total).toBe(37.5);
  });

  test("core count change (hot-plug) → zeros rather than garbage", () => {
    const r = computeCpuFromSamples(sample(0, times(0, 0, 0)), sample(1, times(1, 1, 1), times(1, 1, 1)));
    expect(r.cores).toEqual([0, 0]);
  });

  test("a core with no elapsed time reports 0, never NaN", () => {
    const r = computeCpuFromSamples(sample(0, times(5, 5, 5)), sample(1, times(5, 5, 5)));
    expect(r.cores).toEqual([0]);
    expect(r.total).toBe(0);
  });
});

describe("sampleCpuTimes", () => {
  test("returns plain copies, one per logical CPU", () => {
    const s = sampleCpuTimes(123);
    expect(s.at).toBe(123);
    expect(s.times.length).toBe(os.cpus().length);
    expect(Object.getPrototypeOf(s.times[0])).toBe(Object.prototype);
  });

  test("two samples 200 ms apart under load produce a non-zero delta (Bun 1.3.10 stale-times bug)", () => {
    // Bun 1.3.10 on Windows returns identical `times` on a second os.cpus()
    // call while the first array is still referenced. Copying the numbers out
    // (which sampleCpuTimes does) must make the delta track wall time.
    const a = sampleCpuTimes(Date.now());
    const end = Date.now() + 200;
    let x = 0;
    while (Date.now() < end) x += Math.sqrt(x + 1); // keep this core busy
    const b = sampleCpuTimes(Date.now());
    const totalTicks = (s: CpuTimesSample) => s.times.reduce((n, t) => n + t.user + t.nice + t.sys + t.idle + t.irq, 0);
    expect(totalTicks(b)).toBeGreaterThan(totalTicks(a));
    expect(x).toBeGreaterThan(0);
  });
});

describe("collectMemory", () => {
  test("uses MemAvailable when /proc/meminfo is present", () => {
    const meminfo = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\n";
    const m = collectMemory(() => meminfo);
    expect(m.availableMB).toBeCloseTo(8000000 / 1024, 0);
    expect(m.totalMB).toBeCloseTo(os.totalmem() / 1024 / 1024, 0);
    expect(m.usedMB + m.availableMB).toBeCloseTo(m.totalMB, 0);
    expect(m.percent).toBeGreaterThanOrEqual(0);
    expect(m.percent).toBeLessThanOrEqual(100);
  });

  test("falls back to os.freemem() when meminfo is unavailable", () => {
    const m = collectMemory(() => null);
    expect(m.totalMB).toBeGreaterThan(0);
    expect(m.availableMB).toBeGreaterThan(0);
    expect(m.availableMB).toBeLessThanOrEqual(m.totalMB);
  });

  test("parseMemAvailableBytes handles a missing key", () => {
    expect(parseMemAvailableBytes("MemTotal: 1 kB\n")).toBeNull();
    expect(parseMemAvailableBytes("MemAvailable:    2048 kB")).toBe(2048 * 1024);
  });
});
