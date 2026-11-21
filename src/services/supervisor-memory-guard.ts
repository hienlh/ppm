import { memoryGuardSettings, type MemoryGuardConfig, type MemoryGuardSettings } from "../shared/memory-guard.ts";
import { describeGrowth, fastestGrowth, type MemoryPulse } from "./memory-pulse.ts";
import { commitExhausted, type SystemCommit } from "./system-commit.ts";
import type { StartReason } from "./restart-news/start-reason.ts";

/**
 * The supervisor's half of the memory guard: how a server that died, or stopped answering, while
 * the machine was out of memory is treated. Pure; the supervisor feeds it readings.
 *
 * A server killed by an exhausted machine is not "crashing": restarting it at once into the same
 * machine kills it again, and the ordinary crash budget (10 restarts, then paused until someone
 * types `ppm restart --force`) would leave PPM paused for good after one bad test run. So such an
 * exit waits for free commit to stop being exhausted (`commitExhausted`: 2 GB or 5% of the limit),
 * backs off on its own scale, and never counts toward the pause. Likewise a server that stops
 * answering while memory is exhausted is paging, not hung: killing it frees nothing the culprit
 * holds, so the health check does not count those misses — for a while.
 *
 * "Exhausted", not "under the block threshold": a machine that normally runs with less free commit
 * than the user's threshold would otherwise read every crash as out of memory and hold every
 * restart for minutes. The thresholds are for the gate and the warnings.
 */

export const OOM_BACKOFF_BASE_MS = 15_000;
export const OOM_BACKOFF_MAX_MS = 120_000;
/** Longest wait for memory before starting the server anyway. */
export const MAX_MEMORY_WAIT_MS = 10 * 60_000;
/** How long health misses under low memory are forgiven before they count again. */
export const LOW_MEMORY_HEALTH_GRACE_MS = 10 * 60_000;
/** How often the supervisor reads free commit while it waits. */
export const MEMORY_POLL_MS = 15_000;

/** The memory guard settings from the raw `ai` config value (a JSON string or an object). */
export function memoryGuardFromRaw(raw: unknown): MemoryGuardSettings {
  let ai: unknown = raw;
  if (typeof raw === "string") {
    try { ai = JSON.parse(raw); } catch { ai = undefined; }
  }
  return memoryGuardSettings(ai && typeof ai === "object" ? (ai as MemoryGuardConfig) : undefined);
}

/** Whether free commit is exhausted; false when unreadable. */
export const memoryExhausted = (commit: SystemCommit | null): boolean => commitExhausted(commit);

/** The wait before the `n`th memory restart in a row (1-based). */
export const oomBackoffMs = (n: number): number => Math.min(OOM_BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), OOM_BACKOFF_MAX_MS);

const gb = (mb: number) => (mb / 1024).toFixed(1);

/** The start reason for the server after one that died with the machine out of memory. */
export function oomExitReason(exit: { exitCode: number | null; signal: string; upForS: number }, commit: SystemCommit, pulse: MemoryPulse | null): StartReason {
  const growth = fastestGrowth(pulse?.samples ?? []);
  const parts = [
    `the server exited (exit ${exit.exitCode}, signal ${exit.signal}, after ${exit.upForS}s) with ${gb(commit.freeMB)} of ${gb(commit.limitMB)} GB of commit free`,
  ];
  if (growth) parts.push(`${describeGrowth(growth)} before it`);
  return { kind: "oom", detail: parts.join("; ") };
}

/**
 * Whether a missed health probe counts toward killing the server. While memory is exhausted it
 * does not, for up to {@link LOW_MEMORY_HEALTH_GRACE_MS}; `lowSince` is when that started (kept by
 * the caller, cleared once memory is back).
 */
export function healthMissCounts(exhausted: boolean, lowSince: number | null, now: number): { counts: boolean; lowSince: number | null } {
  if (!exhausted) return { counts: true, lowSince: null };
  const since = lowSince ?? now;
  return { counts: now - since >= LOW_MEMORY_HEALTH_GRACE_MS, lowSince: since };
}
