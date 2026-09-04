/**
 * Instantaneous per-process CPU% from cumulative CPU time, shared by all OSes.
 *
 * Every OS's "CPU%" column is a lifetime average (`ps %cpu`, `/proc` utime over
 * elapsed) — exactly why the old sparkline was a flat line. Machine-normalised
 * like Task Manager: `deltaCpuMs / (wallMs × coreCount) × 100`, so a busy single
 * thread on a 20-core box reads 5 % and group roll-ups sum to roughly the
 * system total.
 */

export interface CpuTimeSample {
  /** `${pid}:${startedAt}` — the same pid with a new start time is a new
   *  process and gets a fresh baseline. `${pid}:0` when the start is unknown,
   *  an accepted hole that mis-attributes at most one tick. */
  key: string;
  cpuMs: number;
}

export interface CpuDeltaState {
  at: number;
  byKey: Map<string, number>;
}

export function cpuSampleKey(pid: number, startedAt: number): string {
  return `${pid}:${startedAt}`;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Unknown key → 0 (a first observation is never a guess). Counter going
 * backwards → 0 and the baseline is reset. Dead keys are dropped from `next`
 * every tick so a long session cannot grow the map without bound.
 */
export function computeCpuPercents(
  prev: CpuDeltaState | null,
  samples: readonly CpuTimeSample[],
  now: number,
  coreCount: number,
): { percentByKey: Map<string, number>; next: CpuDeltaState } {
  const percentByKey = new Map<string, number>();
  const nextByKey = new Map<string, number>();
  const wallMs = prev ? now - prev.at : 0;
  const cores = Math.max(1, coreCount);
  const usable = prev !== null && wallMs > 0;

  for (const s of samples) {
    nextByKey.set(s.key, s.cpuMs);
    let pct = 0;
    if (usable) {
      const before = prev!.byKey.get(s.key);
      if (before !== undefined) {
        const delta = s.cpuMs - before;
        if (delta >= 0) pct = round1(Math.min(100, (delta / (wallMs * cores)) * 100));
      }
    }
    percentByKey.set(s.key, pct);
  }

  return { percentByKey, next: { at: now, byKey: nextByKey } };
}
