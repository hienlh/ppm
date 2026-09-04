/**
 * Cumulative byte counters → bytes/second. Disk and net are the same problem
 * twice, so one helper serves both.
 */
import type { RateMetrics } from "../../types/system-metrics.ts";

export interface CounterSample {
  inBytes: number;
  outBytes: number;
  /** The counter's OWN clock, in seconds — never `Date.now()` when the source
   *  carries a timestamp, because the tick's scheduling jitter (a Windows CIM
   *  round trip alone is ~174 ms and can slip) would otherwise leak into the rate. */
  atSec: number;
}

const UINT32 = 2 ** 32;
/** Faster than any bus this code will meet; a corrected wrap that lands above
 *  it is a counter reset, not a transfer. */
const MAX_PLAUSIBLE_BPS = 100 * 1024 ** 3;

export const UNAVAILABLE_RATE: RateMetrics = { inBps: 0, outBps: 0, available: false };

/**
 * - first sample → `available:false` (no baseline)
 * - non-positive interval → `available:false`
 * - negative delta → retry with +2^32 (`BytesReceivedPersec` is a 32-bit counter
 *   that wraps roughly every 34 s of sustained gigabit); accept only when the
 *   corrected rate is physically plausible, else `available:false`
 */
export function toRate(prev: CounterSample | null, next: CounterSample): RateMetrics {
  if (!prev) return UNAVAILABLE_RATE;
  const dt = next.atSec - prev.atSec;
  if (!Number.isFinite(dt) || dt <= 0) return UNAVAILABLE_RATE;

  const inBps = deltaRate(next.inBytes - prev.inBytes, dt);
  const outBps = deltaRate(next.outBytes - prev.outBytes, dt);
  if (inBps === null || outBps === null) return UNAVAILABLE_RATE;
  return { inBps, outBps, available: true };
}

function deltaRate(delta: number, dtSec: number): number | null {
  if (!Number.isFinite(delta)) return null;
  const corrected = delta < 0 ? delta + UINT32 : delta;
  if (corrected < 0) return null;
  const bps = Math.round(corrected / dtSec);
  return bps > MAX_PLAUSIBLE_BPS ? null : bps;
}
