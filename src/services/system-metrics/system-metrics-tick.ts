/**
 * Assembles ONE snapshot for a tier. Touches only local variables and returns
 * the next delta state alongside the snapshot, so the service can commit the
 * baseline as a single unit AFTER a full assembly — a collector throwing halfway
 * can then never leave a half-advanced baseline behind.
 */
import type {
  MetricsPlatform, MetricsSnapshot, MetricsTier, MemoryMetrics, ProcessColumnAvailability, ProcessSignal, SystemMetrics,
} from "../../types/system-metrics.ts";
import { METRICS_INTERVAL_MS, METRICS_LIGHT_INTERVAL_MS } from "../../types/system-metrics.ts";
import { computeCpuFromSamples, type CpuTimesSample } from "./cpu-memory-collector.ts";
import { toRate, UNAVAILABLE_RATE, type CounterSample } from "./rate-delta.ts";
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";
import type { AppInfo } from "../../types/system-metrics.ts";
import type { AppCollector } from "../system-services/apps-linux.ts";
import type { DeviceCollector, DeviceSampleState } from "./device-collector-types.ts";
import { EMPTY_DEVICE_STATE } from "./device-collector-types.ts";
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
  /** Per-device counters, keyed by device id — one baseline each. */
  devices: DeviceSampleState;
}

export const EMPTY_DELTA_STATE: TickDeltaState = {
  cpu: null, disk: null, net: null, procCpu: null, procIo: null, devices: EMPTY_DEVICE_STATE,
};

export interface TickDeps {
  platform: MetricsPlatform;
  memory: () => MemoryMetrics;
  processes: ProcessCollector;
  /** Null on win32 — the counters ride along in the process round trip. */
  diskNet: (() => Promise<DiskNetCounters>) | null;
  gpus: GpuCollector;
  /** Null where this host lists no drives or interfaces of its own. */
  devices: DeviceCollector | null;
  /** Signals this host can actually deliver, published so the client builds its
   *  Send-Signal menu from the host instead of guessing from the platform name.
   *  Omitted → published as absent, which an older client already tolerates. */
  signals?: readonly ProcessSignal[];
  /** Desktop applications. Omitted or null on a host that lists none. */
  apps?: AppCollector | null;
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
  // Undefined means "this server does not list apps"; an empty array means "it
  // does, and none are running". The UI hides the page only for the first.
  let apps: AppInfo[] | undefined;
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
    collectDevices(system, nextState, deps, warnings);

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
    if (collection && deps.apps) {
      try {
        apps = deps.apps(collection.rows);
      } catch (e) {
        // One unreadable cgroup must cost the app list, never the snapshot.
        warnings.push(`App list unavailable this tick: ${(e as Error)?.message ?? String(e)}`);
      }
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
    // Only in the tier that has process rows to act on, and only when this host
    // can deliver something — an empty menu is the same information as no menu.
    signals: tier === "full" && deps.signals?.length ? [...deps.signals] : undefined,
    apps,
  };
  return { snapshot, nextState, guardCtx };
}

/** A light-tier view of a full snapshot, so one timer can feed both tiers. */
export function projectLight(full: MetricsSnapshot): MetricsSnapshot {
  return {
    ...full,
    tier: "light",
    system: {
      ...full.system,
      disk: UNAVAILABLE_RATE, net: UNAVAILABLE_RATE, gpus: [], processCount: 0,
      disks: undefined, nics: undefined, fans: undefined,
    },
    groups: [],
    processes: [],
    processColumns: NO_PROCESS_COLUMNS,
    // Everything that only means something beside a process row goes with them.
    signals: undefined,
    apps: undefined,
    total: { ...full.total, processCount: 0 },
  };
}

/** Per-device figures are best-effort: a `/sys` read failing must cost the drive
 *  and interface lists, never the whole snapshot. The baseline is only advanced
 *  when the call returned, so a failed tick re-measures from the last good one. */
function collectDevices(
  system: SystemMetrics,
  nextState: TickDeltaState,
  deps: TickDeps,
  warnings: string[],
): void {
  if (!deps.devices) return;
  try {
    const collected = deps.devices(nextState.devices);
    system.disks = collected.disks;
    system.nics = collected.nics;
    if (collected.fans.length > 0) system.fans = collected.fans;
    // Appended, not replaced: nvidia-smi covers the one driver sysfs cannot, and
    // `collectLinuxGpus` deliberately skips those cards so neither is listed twice.
    if (collected.gpus.length > 0) system.gpus = [...system.gpus, ...collected.gpus];
    // Merged, never assigned: `cpu` already holds the cross-platform busy figures
    // computed from the os.cpus() delta, which this collector does not measure.
    Object.assign(system.cpu, collected.cpu);
    nextState.devices = collected.next;
  } catch (e) {
    warnings.push(`Per-device figures unavailable this tick: ${(e as Error)?.message ?? String(e)}`);
  }
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
