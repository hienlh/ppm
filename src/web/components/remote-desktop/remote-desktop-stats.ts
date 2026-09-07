/**
 * Pure fps/KB-per-second math for the stats overlay. Both inputs are cumulative, monotonically
 * increasing counters (decoder frame count, total bytes received) sampled at two points in
 * time — the overlay polls at ~2Hz and calls this on each tick with the previous and current
 * sample, giving a rolling ~500ms window without needing a ring buffer of history.
 */
export interface RemoteDesktopStatsSample {
  frameCount: number;
  totalBytes: number;
  /** Sample timestamp, e.g. `performance.now()` — any monotonic clock, ms. */
  atMs: number;
}

export interface RemoteDesktopStats {
  fps: number;
  kbps: number;
}

const ZERO_STATS: RemoteDesktopStats = { fps: 0, kbps: 0 };

/**
 * Derives instantaneous fps/KB-per-s from two samples. Returns zeros (rather than dividing by
 * zero or a negative interval) when `elapsedMs` isn't positive, and clamps a negative frame/byte
 * delta to zero — the counters reset to 0 on a reconnect, so a sample straddling that moment
 * would otherwise read as a huge negative rate for one tick.
 */
export function computeRemoteDesktopStats(prev: RemoteDesktopStatsSample, next: RemoteDesktopStatsSample): RemoteDesktopStats {
  const elapsedMs = next.atMs - prev.atMs;
  if (elapsedMs <= 0) return ZERO_STATS;
  const elapsedSec = elapsedMs / 1000;
  const frames = Math.max(0, next.frameCount - prev.frameCount);
  const bytes = Math.max(0, next.totalBytes - prev.totalBytes);
  return {
    fps: frames / elapsedSec,
    kbps: bytes / 1024 / elapsedSec,
  };
}
