/**
 * Whole-machine CPU + memory. Runs in both tiers.
 *
 * Reads files on Linux and spawns nothing there. On darwin it spawns exactly one
 * `sysctl` per tick for swap, which `node:os` does not carry — measured at
 * 1.33 ms, see `memory-darwin.ts`.
 */
import os from "node:os";
import { readFileSync } from "node:fs";
import type { CpuMetrics, MemoryMetrics } from "../../types/system-metrics.ts";
import { enrichMemory, readZramTotals, type ZramTotals } from "./memory-linux.ts";
import { parseSwapUsage, readSwapUsage } from "./memory-darwin.ts";

export interface CoreTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
  /** Blocked on I/O: neither busy nor idle. `os.cpus()` has no field for it and
   *  libuv reads the column into a throwaway, so these three are 0 on any host
   *  whose sample came from there — see `sampleCpuTimes`. */
  iowait: number;
  softirq: number;
  steal: number;
}

const NO_EXTRA = { iowait: 0, softirq: 0, steal: 0 } as const;

export interface CpuTimesSample {
  times: CoreTimes[];
  /** Wall clock of the sample, epoch ms. */
  at: number;
  model: string;
}

/** Read `/proc/stat` on Linux, null elsewhere or on failure. Injectable for tests. */
export function readProcStat(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync("/proc/stat", "utf-8");
  } catch {
    return null;
  }
}

/**
 * Per-core times from a `/proc/stat` dump, in the file's own jiffies. Null when
 * no `cpuN` line is present, so the caller can fall back.
 *
 * `guest`/`guest_nice` are deliberately NOT read: the kernel already counts them
 * inside `user`/`nice`, so adding them would inflate the total and under-report
 * every busy percentage on a host running VMs.
 */
export function parseProcStatCores(stat: string): CoreTimes[] | null {
  const cores: CoreTimes[] = [];
  for (const line of stat.split("\n")) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const n = m[2]!.trim().split(/\s+/).map(Number);
    if (n.length < 8 || n.some((v) => !Number.isFinite(v))) return null;
    cores[Number(m[1])] = {
      user: n[0]!, nice: n[1]!, sys: n[2]!, idle: n[3]!,
      iowait: n[4]!, irq: n[5]!, softirq: n[6]!, steal: n[7]!,
    };
  }
  // A hole would mean a core index we never saw, which no kernel produces — but
  // a sparse array here would crash the delta, so treat it as unusable.
  if (cores.length === 0 || cores.some((c) => c === undefined)) return null;
  return cores;
}

/**
 * Prefer `/proc/stat`; fall back to `os.cpus()`.
 *
 * `os.cpus()` cannot express a core that is blocked on I/O. libuv's Linux
 * `uv_cpu_info` reads the `iowait`, `softirq` and `steal` columns into a
 * throwaway variable, so a core parked in iowait shows a *tiny* total delta with
 * no idle in it — measured on this host, 6 jiffies of which 0 were idle while
 * the kernel reported 195 of 201 in iowait, i.e. the Overview card drew one core
 * pinned at a red **100%** while it was 3% busy and waiting on a disk write.
 *
 * The fallback still copies the numbers out immediately: Bun 1.3.10 on Windows
 * returns the SAME `times` object on a later call while the previous array is
 * still referenced, and the delta then reads 0 % forever with no error anywhere.
 */
export function sampleCpuTimes(
  now: number = Date.now(),
  stat: () => string | null = readProcStat,
): CpuTimesSample {
  const cpus = os.cpus();
  const model = cpus[0]?.model?.trim() ?? "";
  const dump = stat();
  const fromProc = dump ? parseProcStatCores(dump) : null;
  if (fromProc && fromProc.length === cpus.length) return { times: fromProc, at: now, model };
  return { times: cpus.map((c) => ({ ...c.times, ...NO_EXTRA })), at: now, model };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Busy % total + per core between two samples. Pure. First sample → all zeros.
 *
 * The kernel share is `sys + irq` over the same interval — Mission Center draws
 * it as a second, darker line under the total, so it is a SUBSET of `total` and
 * must never be added to it.
 */
export function computeCpuFromSamples(prev: CpuTimesSample | null, next: CpuTimesSample): CpuMetrics {
  const zeros: CpuMetrics = {
    total: 0, cores: next.times.map(() => 0), model: next.model,
    kernelPercent: 0, coreKernel: next.times.map(() => 0),
  };
  if (!prev || prev.times.length !== next.times.length) return zeros;

  let busySum = 0;
  let kernelSum = 0;
  let totalSum = 0;
  const coreKernel: number[] = [];
  const cores = next.times.map((n, i) => {
    const p = prev.times[i]!;
    // Waiting on I/O is not work. Folding it into `idle` is what `top` and
    // Mission Center both do, and leaving it out of `total` altogether is the
    // bug that drew an idle core at 100% — see `sampleCpuTimes`.
    const notBusy = (n.idle - p.idle) + (n.iowait - p.iowait);
    const kernel = (n.sys - p.sys) + (n.irq - p.irq) + (n.softirq - p.softirq);
    const total = (n.user - p.user) + (n.nice - p.nice) + kernel
      + notBusy + (n.steal - p.steal);
    if (!(total > 0)) {
      coreKernel.push(0);
      return 0;
    }
    busySum += total - notBusy;
    kernelSum += kernel;
    totalSum += total;
    coreKernel.push(clampPercent(kernel / total * 100));
    return clampPercent((total - notBusy) / total * 100);
  });
  const total = totalSum > 0 ? clampPercent(busySum / totalSum * 100) : 0;
  const kernelPercent = totalSum > 0 ? clampPercent(kernelSum / totalSum * 100) : 0;
  return { total, cores, model: next.model, kernelPercent, coreKernel };
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
 * On **darwin** `freemem()` is already right and must be left alone: it agrees
 * with what `top` calls unused (75 MB against this figure's 124 MB on the same
 * host, sampled seconds apart), which is the number Activity Monitor shows.
 *
 * Swap is the one field macOS publishes and `os` does not, so it is fetched
 * separately — see `memory-darwin.ts` for why that costs a spawn and why the
 * page counts from `vm_stat` are deliberately not used.
 */
export function collectMemory(
  meminfo: () => string | null = readMeminfo,
  zram: () => ZramTotals | undefined = defaultZram,
  swapusage: () => string | null = readSwapUsage,
): MemoryMetrics {
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
  const base: MemoryMetrics = { totalMB, usedMB, availableMB, percent };
  // `info` is null off Linux, so the composition fields simply stay absent there
  // — but swap is not one of those: macOS answers for it, and leaving it absent
  // rendered an em dash on a host with 8 GB of swap in use.
  if (info) return enrichMemory(base, info, zram());
  return { ...base, ...parseSwapUsage(swapusage()) };
}

/** Two `/sys` reads on a host that has zram and one cheap directory listing on
 *  one that does not — small enough to run per tick, unlike the DIMM layout. */
function defaultZram(): ZramTotals | undefined {
  return readZramTotals();
}
