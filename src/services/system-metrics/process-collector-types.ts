/** Shared shapes between the per-OS process collectors and the tick assembler. */
import type { ProcessColumnAvailability } from "../../types/system-metrics.ts";
import type { CounterSample } from "./rate-delta.ts";

export interface RawProcessRow {
  pid: number;
  /** -1 when unknown. */
  ppid: number;
  /** Executable basename without extension, original case. */
  name: string;
  /** Raw command line, or null when unreadable / not yet fetched. */
  command: string | null;
  /** Cumulative CPU time (user + kernel), milliseconds. */
  cpuMs: number;
  ramMB: number;
  /** Epoch ms UTC; 0 when unknown. */
  startedAt: number;
  /** CUMULATIVE per-process byte counters. The rows builder turns them into
   *  bytes/second over the tick's wall interval, exactly like `cpuMs` — a
   *  collector must never pre-compute a rate from them. `undefined` = this OS
   *  (or this pid, e.g. an access-denied `/proc/<pid>/io`) does not expose it. */
  diskReadBytes?: number;
  diskWriteBytes?: number;
  netInBytes?: number;
  netOutBytes?: number;
  /** ALREADY a rate, 0-100: the GPU busy counters carry their own high-resolution
   *  clock, so their delta cannot use the wall interval and is computed by the
   *  collector instead. */
  gpuPct?: number;
  gpuMemMB?: number;
}

export interface ProcessCollection {
  rows: RawProcessRow[];
  /** Windows piggybacks the disk/net counters on the same round trip. */
  disk?: CounterSample | null;
  net?: CounterSample | null;
  /** Which optional per-process columns this collector can fill on this host.
   *  Absent = none (the platform has no per-process disk/gpu/net source). */
  columns?: ProcessColumnAvailability;
  warnings: string[];
}

export interface ProcessCollector {
  collect(): Promise<ProcessCollection>;
  /** Release any long-lived child. Must be safe to call repeatedly. */
  stop(): void;
}

/** Frozen: it is shared by every light-tier snapshot, so an accidental mutation
 *  would rewrite history for all of them. */
export const NO_PROCESS_COLUMNS: ProcessColumnAvailability = Object.freeze({ disk: false, gpu: false, net: false });

/**
 * Sticky column availability. A capability is advertised as soon as it has
 * produced a value ONCE on this host and is never withdrawn: a single tick
 * where the GPU perf provider hiccups (or where every process happens to be
 * idle) must not make the UI drop a whole column and re-add it 2 s later.
 * Machines do not lose hardware mid-session.
 */
export function createStickyColumns(): (seen: Partial<ProcessColumnAvailability>) => ProcessColumnAvailability {
  const state: ProcessColumnAvailability = { ...NO_PROCESS_COLUMNS };
  return (seen) => {
    state.disk ||= seen.disk === true;
    state.gpu ||= seen.gpu === true;
    state.net ||= seen.net === true;
    return { ...state };
  };
}

/** A collector for platforms without process support: always empty. */
export const EMPTY_PROCESS_COLLECTOR: ProcessCollector = {
  collect: async () => ({ rows: [], warnings: [] }),
  stop: () => {},
};

/** Windows image names carry an extension (`explorer.exe`); nothing else does. */
export function stripExecutableExtension(name: string): string {
  return name.replace(/\.(exe|com|scr|bat|cmd)$/i, "");
}
