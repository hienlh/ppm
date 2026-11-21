import { readFileSync } from "node:fs";

/**
 * How much memory the machine can still hand out, as one pair of numbers every memory guard reads.
 *
 * Windows: the commit charge — what `VirtualAlloc` is refused against. When it runs out every
 * process that asks for memory fails at once (on 20/11/2026 a chat's jest took the machine there
 * and the PPM server, its supervisor, codex and the WireGuard service all died in the same second),
 * so free *commit*, not free RAM, is the number that predicts it. Read with `K32GetPerformanceInfo`
 * over FFI (`readWindowsCommit`), no child process.
 *
 * Linux: overcommit makes `Committed_AS` a poor predictor (it routinely exceeds `CommitLimit`
 * harmlessly), so "free" is what the kernel says it can still give without the OOM killer:
 * `MemAvailable` plus free swap, out of RAM plus swap.
 *
 * Elsewhere: null. Every caller treats null as "cannot tell" and does nothing.
 */
export interface SystemCommit {
  freeMB: number;
  limitMB: number;
}

/** The figures in `/proc/meminfo`, or null when the ones needed are missing. Exported for tests. */
export function parseLinuxMeminfo(text: string): SystemCommit | null {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === undefined || available === undefined) return null;
  const swapTotal = kb("SwapTotal") ?? 0;
  const swapFree = kb("SwapFree") ?? 0;
  return { freeMB: Math.round((available + swapFree) / 1024), limitMB: Math.round((total + swapTotal) / 1024) };
}

/** Free commit right now; null when this platform cannot be read. Never throws. */
export async function readSystemCommit(platform: NodeJS.Platform = process.platform): Promise<SystemCommit | null> {
  try {
    if (platform === "win32") {
      const { readWindowsCommit } = await import("./assistant-mcp/assistant-system-windows-memory.ts");
      const c = await readWindowsCommit(platform);
      if (!c || c.commitLimitMB <= 0) return null;
      return { freeMB: Math.max(0, c.commitLimitMB - c.commitUsedMB), limitMB: c.commitLimitMB };
    }
    if (platform === "linux") return parseLinuxMeminfo(readFileSync("/proc/meminfo", "utf-8"));
  } catch { /* unreadable */ }
  return null;
}

/** Free commit at or under this share of the limit is exhausted, whatever the thresholds say. */
export const EXHAUSTED_SHARE = 0.05;
/** …as is free commit at or under this many MB, whatever the limit. */
export const EXHAUSTED_MB = 2048;

/**
 * Whether the machine is out of memory now, not merely low on it. The restart paths (the
 * supervisor's wait, the watchdog task, a death diagnosis) go by this rather than by the user's
 * block threshold: a machine that normally runs with less free commit than the threshold would
 * otherwise have every crash read as out of memory and every restart held for minutes.
 */
export const commitExhausted = (c: SystemCommit | null): boolean =>
  !!c && (c.freeMB <= EXHAUSTED_MB || c.freeMB <= c.limitMB * EXHAUSTED_SHARE);

/** "4.4 of 51.9 GB free", for a log line or a notification. */
export function describeCommit(c: SystemCommit): string {
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  return `${gb(c.freeMB)} of ${gb(c.limitMB)} GB free`;
}
