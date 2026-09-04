/**
 * Live re-query for a kill request. A pid is not an identity: Windows recycles
 * pids fast enough that the `node` the user clicked two seconds ago can be
 * `lsass` by the time the POST lands. The route therefore never authorises
 * against the snapshot — it re-collects the process table (one round trip, the
 * same per-OS source the tick uses), compares the client's `startedAt` claim
 * with the live one, and hands the guard the FRESH name plus fresh ppid maps.
 */
import type { ProcessCollector, RawProcessRow } from "./process-collector-types.ts";

export interface LiveProcessIdentity {
  pid: number;
  name: string;
  startedAt: number;
}

/** macOS `ps` start times are 1 s resolution and other sources may be coarser. */
export const IDENTITY_TOLERANCE_MS = 2000;

/** An unknown start time (0) on either side cannot prove a mismatch. */
export function identityMatches(claimedStartedAt: number, liveStartedAt: number): boolean {
  if (!claimedStartedAt || !liveStartedAt) return true;
  return Math.abs(claimedStartedAt - liveStartedAt) <= IDENTITY_TOLERANCE_MS;
}

export interface GuardMaps {
  ppidOf: Map<number, number>;
  startedAtOf: Map<number, number>;
  byPid: Map<number, RawProcessRow>;
  /** Rows that were refused because their pid was already present. */
  warnings: string[];
}

/**
 * A pid appears once in any real process table. A second row for the same pid
 * can only be a forged line that slipped through the transport, so the FIRST
 * row wins and the duplicate is refused — a forgery must never be able to
 * overwrite the name the kill guard is about to trust.
 */
export function buildGuardMaps(rows: readonly RawProcessRow[]): GuardMaps {
  const ppidOf = new Map<number, number>();
  const startedAtOf = new Map<number, number>();
  const byPid = new Map<number, RawProcessRow>();
  const warnings: string[] = [];
  for (const r of rows) {
    if (byPid.has(r.pid)) {
      warnings.push(`Duplicate row for PID ${r.pid} ignored (name "${r.name}")`);
      continue;
    }
    byPid.set(r.pid, r);
    ppidOf.set(r.pid, r.ppid);
    startedAtOf.set(r.pid, r.startedAt);
  }
  return { ppidOf, startedAtOf, byPid, warnings };
}

export interface LiveResolution {
  live: LiveProcessIdentity | null;
  maps: GuardMaps;
  warnings: string[];
}

export async function resolveLiveProcess(pid: number, collector: ProcessCollector): Promise<LiveResolution> {
  const collection = await collector.collect();
  const maps = buildGuardMaps(collection.rows);
  const row = maps.byPid.get(pid);
  return {
    live: row ? { pid: row.pid, name: row.name, startedAt: row.startedAt } : null,
    maps,
    warnings: [...collection.warnings, ...maps.warnings],
  };
}
