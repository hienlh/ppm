/**
 * Whole-machine CPU + memory from `node:os`. Runs in both tiers, spawns nothing.
 */
import os from "node:os";
import { readFileSync } from "node:fs";
import type { CpuMetrics, MemoryMetrics } from "../../types/system-metrics.ts";

export interface CoreTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export interface CpuTimesSample {
  times: CoreTimes[];
  /** Wall clock of the sample, epoch ms. */
  at: number;
  model: string;
}

/**
 * Read `os.cpus()` and copy the numbers out immediately. Bun 1.3.10 on Windows
 * returns the SAME `times` on a later call while the array from the previous
 * call is still referenced — the delta then reads 0 % forever, with no error
 * anywhere. Keeping only plain copies between ticks avoids it.
 */
export function sampleCpuTimes(now: number = Date.now()): CpuTimesSample {
  const cpus = os.cpus();
  const times = cpus.map((c) => ({ ...c.times }));
  return { times, at: now, model: cpus[0]?.model?.trim() ?? "" };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Busy % total + per core between two samples. Pure. First sample → all zeros. */
export function computeCpuFromSamples(prev: CpuTimesSample | null, next: CpuTimesSample): CpuMetrics {
  const zeros: CpuMetrics = { total: 0, cores: next.times.map(() => 0), model: next.model };
  if (!prev || prev.times.length !== next.times.length) return zeros;

  let busySum = 0;
  let totalSum = 0;
  const cores = next.times.map((n, i) => {
    const p = prev.times[i]!;
    const idle = n.idle - p.idle;
    const total = (n.user - p.user) + (n.nice - p.nice) + (n.sys - p.sys) + idle + (n.irq - p.irq);
    if (!(total > 0)) return 0;
    busySum += total - idle;
    totalSum += total;
    return clampPercent((total - idle) / total * 100);
  });
  const total = totalSum > 0 ? clampPercent(busySum / totalSum * 100) : 0;
  return { total, cores, model: next.model };
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return round1(Math.min(100, Math.max(0, v)));
}

/** Read `/proc/meminfo` on Linux, null elsewhere or on failure. Injectable for tests. */
export function readMeminfo(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync("/proc/meminfo", "utf-8");
  } catch {
    return null;
  }
}

/** `MemAvailable` in bytes from a `/proc/meminfo` dump, or null when absent. */
export function parseMemAvailableBytes(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * `os.totalmem()` matches `Win32_OperatingSystem.TotalVisibleMemorySize` exactly
 * and `os.freemem()` is within 0.2 GiB of CIM's `FreePhysicalMemory`. On Linux
 * `freemem()` is `MemFree`, which makes a warm page cache look like a nearly
 * full machine — `MemAvailable` is what `free` and Task-Manager-like tools show.
 */
export function collectMemory(meminfo: () => string | null = readMeminfo): MemoryMetrics {
  const totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  const info = meminfo();
  if (info) {
    const avail = parseMemAvailableBytes(info);
    if (avail !== null) availableBytes = avail;
  }
  availableBytes = Math.min(Math.max(availableBytes, 0), totalBytes);
  const MB = 1024 * 1024;
  const totalMB = round1(totalBytes / MB);
  const availableMB = round1(availableBytes / MB);
  const usedMB = round1(Math.max(totalMB - availableMB, 0));
  const percent = totalMB > 0 ? round1(usedMB / totalMB * 100) : 0;
  return { totalMB, usedMB, availableMB, percent };
}
