/**
 * Per-process cumulative byte counters → bytes/second, shared by every OS.
 *
 * The whole-machine helper in `rate-delta.ts` cannot serve here: it works on a
 * counter's OWN clock and corrects 32-bit wraps, whereas these counters are
 * 64-bit per-process totals sampled on the tick's wall clock. So the identity
 * rules are the same as the CPU delta's (`pid:startedAt` key, first observation
 * is 0, dead keys dropped) and only the units differ.
 *
 * `undefined` in, `undefined` out: a field the OS refused (an access-denied
 * `/proc/<pid>/io`, a Windows property that came back empty) must never become
 * a confident 0.
 */

export interface ProcIoCounters {
  diskReadBytes?: number;
  diskWriteBytes?: number;
  netInBytes?: number;
  netOutBytes?: number;
}

export interface ProcIoSample extends ProcIoCounters {
  /** `${pid}:${startedAt}` — see `cpuSampleKey`. */
  key: string;
}

export interface ProcIoRates {
  diskReadBps?: number;
  diskWriteBps?: number;
  netInBps?: number;
  netOutBps?: number;
}

export interface ProcIoDeltaState {
  at: number;
  byKey: Map<string, ProcIoCounters>;
}

/** Faster than any bus this code will meet; a delta implying more is a counter
 *  reset the OS did not flag, not a transfer. */
const MAX_PLAUSIBLE_BPS = 100 * 1024 ** 3;

export function computeProcIoRates(
  prev: ProcIoDeltaState | null,
  samples: readonly ProcIoSample[],
  now: number,
): { ratesByKey: Map<string, ProcIoRates>; next: ProcIoDeltaState } {
  const ratesByKey = new Map<string, ProcIoRates>();
  const nextByKey = new Map<string, ProcIoCounters>();
  const wallSec = prev ? (now - prev.at) / 1000 : 0;
  const usable = prev !== null && wallSec > 0;

  for (const s of samples) {
    const counters: ProcIoCounters = {
      diskReadBytes: s.diskReadBytes,
      diskWriteBytes: s.diskWriteBytes,
      netInBytes: s.netInBytes,
      netOutBytes: s.netOutBytes,
    };
    nextByKey.set(s.key, counters);
    const before = usable ? prev!.byKey.get(s.key) : undefined;
    ratesByKey.set(s.key, {
      diskReadBps: bps(before?.diskReadBytes, s.diskReadBytes, wallSec),
      diskWriteBps: bps(before?.diskWriteBytes, s.diskWriteBytes, wallSec),
      netInBps: bps(before?.netInBytes, s.netInBytes, wallSec),
      netOutBps: bps(before?.netOutBytes, s.netOutBytes, wallSec),
    });
  }

  return { ratesByKey, next: { at: now, byKey: nextByKey } };
}

/**
 * - counter not reported → `undefined` (unmeasurable, the UI shows "—")
 * - no baseline yet, or the counter went backwards → 0
 */
function bps(before: number | undefined, current: number | undefined, wallSec: number): number | undefined {
  if (current === undefined || !Number.isFinite(current)) return undefined;
  if (before === undefined || wallSec <= 0) return 0;
  const delta = current - before;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  const rate = Math.round(delta / wallSec);
  return rate > MAX_PLAUSIBLE_BPS ? 0 : rate;
}
