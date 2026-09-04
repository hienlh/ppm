/**
 * Per-process GPU busy % and dedicated VRAM on Windows — a PURE parser plus the
 * rate maths over the two tagged sections the per-tick PowerShell round trip
 * already returns. Spawns nothing.
 *
 *   G<TAB>Name<TAB>UtilizationPercentage<TAB>Timestamp_Sys100NS   (busy > 0 only)
 *   M<TAB>Name<TAB>DedicatedUsage
 *
 * `Name` is an instance path, not a friendly name:
 *   pid_29876_luid_0x00000000_0x0000A1B2_phys_0_eng_3_engtype_3D   (GPUEngine)
 *   pid_29876_luid_0x00000000_0x0000A1B2_phys_0                   (GPUProcessMemory)
 *
 * `UtilizationPercentage` is NOT a percentage despite the name: it is a raw
 * cumulative 100 ns busy-time counter, which is why an absolute read is
 * meaningless and it has to be differentiated against the counter's own
 * `Timestamp_Sys100NS` clock rather than the tick's wall interval.
 */
import { toRate, type CounterSample } from "./rate-delta.ts";

/** Both classes prefix the instance with the owning pid. */
const PID_IN_INSTANCE = /(?:^|_)pid_(\d+)_/;
const HUNDRED_NS_PER_SEC = 1e7;
/** busy-100ns/second → percent: (bps / 1e7) × 100. */
const BPS_PER_PERCENT = HUNDRED_NS_PER_SEC / 100;
const BYTES_PER_MB = 1024 * 1024;

export interface GpuEngineSample {
  pid: number;
  /** The full instance path: unique per (pid, adapter, engine), so it is the
   *  delta key. Two engines of the same pid stay separate samples and are
   *  summed only after each has its own rate. */
  engine: string;
  busy100ns: number;
  /** Counter's own clock, seconds. */
  atSec: number;
}

export interface ParsedGpuLines {
  engines: GpuEngineSample[];
  /** pid → dedicated VRAM bytes, summed across physical adapters. */
  memBytesByPid: Map<number, number>;
  /** True when the tick carried either section at all — i.e. the host has the
   *  GPU perf provider. An all-idle machine emits no `G` lines but still emits
   *  `M` lines, so absence of BOTH is what means "unavailable". */
  present: boolean;
}

export interface GpuUsageState {
  byKey: Map<string, CounterSample>;
}

export function pidFromInstanceName(name: string): number | null {
  const m = PID_IN_INSTANCE.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function parseGpuLines(lines: readonly string[]): ParsedGpuLines {
  const engines: GpuEngineSample[] = [];
  const memBytesByPid = new Map<number, number>();
  let present = false;

  for (const line of lines) {
    const f = line.split("\t");
    if (f[0] === "G" && f.length >= 4) {
      present = true;
      const pid = pidFromInstanceName(f[1] ?? "");
      const busy = Number(f[2]);
      const ts = Number(f[3]);
      if (pid === null || !Number.isFinite(busy) || !Number.isFinite(ts) || ts <= 0) continue;
      engines.push({ pid, engine: f[1] ?? "", busy100ns: busy, atSec: ts / HUNDRED_NS_PER_SEC });
    } else if (f[0] === "M" && f.length >= 3) {
      present = true;
      const pid = pidFromInstanceName(f[1] ?? "");
      const bytes = Number(f[2]);
      if (pid === null || !Number.isFinite(bytes) || bytes < 0) continue;
      memBytesByPid.set(pid, (memBytesByPid.get(pid) ?? 0) + bytes);
    }
  }
  return { engines, memBytesByPid, present };
}

/**
 * Cumulative engine busy counters → per-pid busy %.
 *
 * - Delta key is `<engine instance>:<startedAt>` so a recycled pid inheriting a
 *   dead process's instance name gets a fresh baseline instead of its busy time.
 * - A pid absent from this tick's process table is dropped: the table is what
 *   the UI shows, and the perf provider keeps instances of exited processes
 *   around for a while.
 * - Per pid the figure is the BUSIEST engine, not the sum across engines — the
 *   same definition Task Manager's GPU column uses. Engines run in parallel, so
 *   a sum would exceed 100 % for any process that renders and copies at once
 *   and would pin at the clamp instead of showing a real load figure.
 * - First observation of an engine → 0 (never a guess), like `cpu`.
 * - Counter going backwards → 0 and a fresh baseline. These are 64-bit 100 ns
 *   counters, so a decrease is a provider restart, never a wrap.
 * - Dead keys are dropped from `next` every tick, so a long session with a lot
 *   of short-lived GPU clients cannot grow the map without bound.
 */
export function computeGpuPercents(
  prev: GpuUsageState | null,
  engines: readonly GpuEngineSample[],
  startedAtOf: (pid: number) => number | undefined,
): { pctByPid: Map<number, number>; next: GpuUsageState } {
  const pctByPid = new Map<number, number>();
  const nextByKey = new Map<string, CounterSample>();

  for (const e of engines) {
    const startedAt = startedAtOf(e.pid);
    if (startedAt === undefined) continue;
    const key = `${e.engine}:${startedAt}`;
    const sample: CounterSample = { inBytes: e.busy100ns, outBytes: 0, atSec: e.atSec };
    const before = prev?.byKey.get(key);
    nextByKey.set(key, sample);
    const pct = enginePercent(before ?? null, sample);
    pctByPid.set(e.pid, Math.max(pctByPid.get(e.pid) ?? 0, pct));
  }

  for (const [pid, pct] of pctByPid) pctByPid.set(pid, clampPercent(pct));
  return { pctByPid, next: { byKey: nextByKey } };
}

function enginePercent(prev: CounterSample | null, next: CounterSample): number {
  if (!prev || next.inBytes < prev.inBytes) return 0;
  const rate = toRate(prev, next);
  if (!rate.available) return 0;
  return rate.inBps / BPS_PER_PERCENT;
}

function clampPercent(v: number): number {
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

export function memBytesToMB(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}
