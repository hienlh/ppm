import { describe, test, expect } from "bun:test";
import os from "node:os";
import {
  computeCpuFromSamples,
  sampleCpuTimes,
  parseProcStatCores,
  collectMemory,
  parseMemAvailableBytes,
  type CpuTimesSample,
} from "../../../../src/services/system-metrics/cpu-memory-collector.ts";

const times = (user: number, sys: number, idle: number) => (
  { user, nice: 0, sys, idle, irq: 0, iowait: 0, softirq: 0, steal: 0 }
);
const sample = (at: number, ...cores: ReturnType<typeof times>[]): CpuTimesSample => ({ times: cores, at, model: "test" });

describe("computeCpuFromSamples", () => {
  test("no previous sample → zeros with the right core count", () => {
    const r = computeCpuFromSamples(null, sample(0, times(1, 1, 1), times(1, 1, 1)));
    expect(r).toEqual({ total: 0, cores: [0, 0], model: "test", kernelPercent: 0, coreKernel: [0, 0] });
  });

  test("the kernel share is sys+irq, a SUBSET of the total and never added to it", () => {
    // Core 0: 300 user + 200 sys of 1000. Core 1: idle but for 100 sys.
    const prev = sample(0, times(0, 0, 0), times(0, 0, 0));
    const next = sample(1000, times(300, 200, 500), times(0, 100, 900));
    const r = computeCpuFromSamples(prev, next);
    expect(r.cores).toEqual([50, 10]);
    expect(r.coreKernel).toEqual([20, 10]);
    expect(r.total).toBe(30);
    expect(r.kernelPercent).toBe(15);
    expect(r.kernelPercent!).toBeLessThanOrEqual(r.total);
  });

  test("irq time counts as kernel, as it does for the total", () => {
    const prev = sample(0, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, iowait: 0, softirq: 0, steal: 0 });
    const next = sample(1000, { user: 0, nice: 0, sys: 100, idle: 800, irq: 100, iowait: 0, softirq: 0, steal: 0 });
    const r = computeCpuFromSamples(prev, next);
    expect(r.coreKernel).toEqual([20]);
    expect(r.cores).toEqual([20]);
  });

  test("busy fraction per core and machine total", () => {
    const prev = sample(0, times(0, 0, 0), times(0, 0, 0));
    const next = sample(1000, times(500, 0, 500), times(0, 250, 750));
    const r = computeCpuFromSamples(prev, next);
    expect(r.cores).toEqual([50, 25]);
    expect(r.total).toBe(37.5);
  });

  test("a core blocked on I/O is not busy — the bug that drew an idle core red", () => {
    // Real numbers off this host: over 2 s the kernel reported core 18 as
    // 2 user + 4 sys + 195 iowait of 201 jiffies. `os.cpus()` cannot see the
    // iowait column at all, so the only window it had was 6 jiffies with no
    // idle in it, and the Overview card drew a solid red 100% bar for a core
    // that was 3% busy waiting on a disk write.
    const prev = sample(0, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, iowait: 0, softirq: 0, steal: 0 });
    const next = sample(2000, { user: 2, nice: 0, sys: 4, idle: 0, irq: 0, iowait: 195, softirq: 0, steal: 0 });
    const r = computeCpuFromSamples(prev, next);
    expect(r.cores[0]).toBeCloseTo(3, 0);
    expect(r.cores[0]).toBeLessThan(10);
  });

  test("softirq is kernel time and counts toward the total, not dropped", () => {
    // libuv discards this column too, so a core busy servicing network
    // interrupts had the same shape of error as the iowait one.
    const prev = sample(0, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, iowait: 0, softirq: 0, steal: 0 });
    const next = sample(1000, { user: 100, nice: 0, sys: 0, idle: 700, irq: 0, iowait: 0, softirq: 200, steal: 0 });
    const r = computeCpuFromSamples(prev, next);
    expect(r.cores).toEqual([30]);
    expect(r.coreKernel).toEqual([20]);
  });

  test("core count change (hot-plug) → zeros rather than garbage", () => {
    const r = computeCpuFromSamples(sample(0, times(0, 0, 0)), sample(1, times(1, 1, 1), times(1, 1, 1)));
    expect(r.cores).toEqual([0, 0]);
  });

  test("a core with no elapsed time reports 0, never NaN", () => {
    const r = computeCpuFromSamples(sample(0, times(5, 5, 5)), sample(1, times(5, 5, 5)));
    expect(r.cores).toEqual([0]);
    expect(r.total).toBe(0);
    expect(r.coreKernel).toEqual([0]);
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

describe("parseProcStatCores", () => {
  test("all eight columns are read, guest and guest_nice deliberately are not", () => {
    // The kernel already counts guest inside user and guest_nice inside nice, so
    // adding them would inflate the total and under-report every percentage.
    const stat = [
      "cpu  100 0 50 900 10 0 5 0 7 3",
      "cpu0 40 1 20 500 8 2 3 1 7 3",
      "cpu1 60 0 30 400 2 0 2 0 0 0",
      "intr 1234",
    ].join("\n");
    expect(parseProcStatCores(stat)).toEqual([
      { user: 40, nice: 1, sys: 20, idle: 500, iowait: 8, irq: 2, softirq: 3, steal: 1 },
      { user: 60, nice: 0, sys: 30, idle: 400, iowait: 2, irq: 0, softirq: 2, steal: 0 },
    ]);
  });

  test("the aggregate `cpu` line is not a core", () => {
    expect(parseProcStatCores("cpu  1 2 3 4 5 6 7 8")).toBeNull();
  });

  test("a kernel too old for the steal column is unusable rather than half-read", () => {
    expect(parseProcStatCores("cpu0 1 2 3 4 5 6")).toBeNull();
  });

  test("a garbled dump answers null so the caller can fall back", () => {
    expect(parseProcStatCores("cpu0 1 2 x 4 5 6 7 8")).toBeNull();
    expect(parseProcStatCores("")).toBeNull();
  });
});

describe("sampleCpuTimes falls back", () => {
  test("no /proc/stat → os.cpus(), with the three missing columns as 0", () => {
    const s = sampleCpuTimes(5, () => null);
    expect(s.times.length).toBe(os.cpus().length);
    expect(s.times.every((t) => t.iowait === 0 && t.softirq === 0 && t.steal === 0)).toBe(true);
  });

  test("a core count that disagrees with os.cpus() is not trusted", () => {
    // A dump naming one core on a multi-core host means we misread it.
    const s = sampleCpuTimes(5, () => "cpu0 1 2 3 4 5 6 7 8");
    if (os.cpus().length > 1) expect(s.times.length).toBe(os.cpus().length);
  });
});
