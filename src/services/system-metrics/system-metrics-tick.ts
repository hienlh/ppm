/**
 * Assembles ONE snapshot for a tier. Touches only local variables and returns
 * the next delta state alongside the snapshot, so the service can commit the
 * baseline as a single unit AFTER a full assembly — a collector throwing halfway
 * can then never leave a half-advanced baseline behind.
 */
import type {
  MetricsPlatform, MetricsSnapshot, MetricsTier, MemoryMetrics, ProcessColumnAvailability, SystemMetrics,
} from "../../types/system-metrics.ts";
import { METRICS_INTERVAL_MS, METRICS_LIGHT_INTERVAL_MS } from "../../types/system-metrics.ts";
import { computeCpuFromSamples, type CpuTimesSample } from "./cpu-memory-collector.ts";
import { toRate, UNAVAILABLE_RATE, type CounterSample } from "./rate-delta.ts";
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";
import type { GpuCollector } from "./gpu-collector-nvidia.ts";
import type { ProcessCollection, ProcessCollector } from "./process-collector-types.ts";
import { NO_PROCESS_COLUMNS } from "./process-collector-types.ts";
import type { CpuDeltaState } from "./process-cpu-delta.ts";
import type { ProcIoDeltaState } from "./process-io-delta.ts";
import { buildProcessRows, type BuildRowsInput } from "./process-rows-builder.ts";
import { groupProcesses } from "./process-grouping.ts";
import type { KillGuardContext } from "./kill-guard.ts";

export interface TickDeltaState {
  cpu: CpuTimesSample | null;
  disk: CounterSample | null;
  net: CounterSample | null;
  procCpu: CpuDeltaState | null;
  procIo: ProcIoDeltaState | null;
}

export const EMPTY_DELTA_STATE: TickDeltaState = { cpu: null, disk: null, net: null, procCpu: null, procIo: null };

export interface TickDeps {
  platform: MetricsPlatform;
  memory: () => MemoryMetrics;
  processes: ProcessCollector;
  /** Null on win32 — the counters ride along in the process round trip. */
  diskNet: (() => Promise<DiskNetCounters>) | null;
  gpus: GpuCollector;
  resolveProtected: BuildRowsInput["resolveProtected"];
  now: () => number;
  sampleCpu: (now: number) => CpuTimesSample;
}

export interface AssembledTick {
  snapshot: MetricsSnapshot;
  nextState: TickDeltaState;
  /** Fresh guard context from this tick's rows (full tier only). */
  guardCtx: KillGuardContext | null;
}

/**
 * `previousFull` is the last published full snapshot. When the process
 * collection itself fails (a wedged CIM call, a busy session) its rows and
 * groups are re-published with a warning and the per-process CPU baseline is
 * kept — committing an empty baseline would make every process read 0 % on the
 * next good tick, and an empty frame would flash the table blank.
 */
export async function assembleTick(
  tier: MetricsTier,
  state: TickDeltaState,
  deps: TickDeps,
  previousFull: MetricsSnapshot | null = null,
): Promise<AssembledTick> {
  const now = deps.now();
  const cpuSample = deps.sampleCpu(now);
  const cpu = computeCpuFromSamples(state.cpu, cpuSample);
  const mem = deps.memory();
  const warnings: string[] = [];

  const system: SystemMetrics = {
    cpu, mem, disk: UNAVAILABLE_RATE, net: UNAVAILABLE_RATE, gpus: [], processCount: 0,
  };
  const nextState: TickDeltaState = { ...state, cpu: cpuSample };
  let groups: MetricsSnapshot["groups"] = [];
  let processes: MetricsSnapshot["processes"] = [];
  let processColumns: ProcessColumnAvailability = NO_PROCESS_COLUMNS;
  let guardCtx: KillGuardContext | null = null;

  if (tier === "full") {
    const collection = await collectProcessesSafely(deps.processes, warnings);
    const counters = await collectCounters(collection ?? { rows: [], warnings: [] }, deps, warnings);
    if (counters.disk) {
      system.disk = toRate(state.disk, counters.disk);
      nextState.disk = counters.disk;
    }
    if (counters.net) {
      system.net = toRate(state.net, counters.net);
      nextState.net = counters.net;
    }
    system.gpus = await deps.gpus.collect();

    if (collection) {
      const built = buildProcessRows({
        rows: collection.rows,
        platform: deps.platform,
        coreCount: cpuSample.times.length,
        now,
        prevCpu: state.procCpu,
        prevIo: state.procIo,
        resolveProtected: deps.resolveProtected,
      });
      warnings.push(...built.maps.warnings);
      nextState.procCpu = built.nextCpu;
      nextState.procIo = built.nextIo;
      processes = built.processes;
      processColumns = collection.columns ?? NO_PROCESS_COLUMNS;
      guardCtx = built.guardCtx;
      groups = groupProcesses(processes, deps.platform, built.protectedPids.roots, built.protectedPids.selfPid);
    } else if (previousFull) {
      processes = previousFull.processes;
      groups = previousFull.groups;
      // Re-published rows keep the columns they were measured with.
      processColumns = previousFull.processColumns;
    }
    system.processCount = processes.length;
  }

  const snapshot: MetricsSnapshot = {
    ts: now,
    platform: deps.platform,
    tier,
    intervalMs: tier === "full" ? METRICS_INTERVAL_MS : METRICS_LIGHT_INTERVAL_MS,
    system,
    groups,
    processes,
    processColumns,
    total: { cpu: cpu.total, ramMB: mem.usedMB, processCount: system.processCount },
    warnings,
  };
  return { snapshot, nextState, guardCtx };
}

/** A light-tier view of a full snapshot, so one timer can feed both tiers. */
export function projectLight(full: MetricsSnapshot): MetricsSnapshot {
  return {
    ...full,
    tier: "light",
    system: { ...full.system, disk: UNAVAILABLE_RATE, net: UNAVAILABLE_RATE, gpus: [], processCount: 0 },
    groups: [],
    processes: [],
    processColumns: NO_PROCESS_COLUMNS,
    total: { ...full.total, processCount: 0 },
  };
}

/** Null means the collection FAILED (as opposed to a legitimately empty table). */
async function collectProcessesSafely(collector: ProcessCollector, warnings: string[]): Promise<ProcessCollection | null> {
  try {
    const c = await collector.collect();
    warnings.push(...c.warnings);
    return c;
  } catch (e) {
    warnings.push(`Process list unavailable this tick: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
}

async function collectCounters(
  collection: ProcessCollection,
  deps: TickDeps,
  warnings: string[],
): Promise<{ disk: CounterSample | null; net: CounterSample | null }> {
  if (collection.disk !== undefined || collection.net !== undefined) {
    if (!collection.disk) warnings.push("Disk throughput unavailable: perf counters returned no _Total row (try `lodctr /R`)");
    if (!collection.net) warnings.push("Network throughput unavailable: perf counters returned no adapters (try `lodctr /R`)");
    return { disk: collection.disk ?? null, net: collection.net ?? null };
  }
  if (!deps.diskNet) return { disk: null, net: null };
  try {
    const c = await deps.diskNet();
    warnings.push(...c.warnings);
    return { disk: c.disk, net: c.net };
  } catch (e) {
    warnings.push(`Disk/network throughput unavailable: ${(e as Error)?.message ?? String(e)}`);
    return { disk: null, net: null };
  }
}
