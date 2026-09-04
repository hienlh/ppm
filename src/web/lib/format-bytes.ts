/** Shared byte/rate formatters for the System Monitor. */

/** Same rounding rule as the deleted `system-monitor-group-row.tsx`. */
export function formatRam(mb: number): string {
  return mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** Bytes/second → human-readable rate, 1 decimal past B/s. */
export function formatBps(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  const kb = bytesPerSec / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB/s`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB/s`;
  return `${(mb / 1024).toFixed(1)} GB/s`;
}
