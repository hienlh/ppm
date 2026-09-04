/** Formatting helpers for a single process row, salvaged from the deleted
 *  `system-monitor-group-row.tsx` byte-for-byte (same thresholds, same rounding).
 *  Grid template logic (which columns exist, the `@lg` trend/age track) now lives
 *  in `process-columns-grid.ts` since it grew a runtime dependency (enabled
 *  optional columns + active sort key) that no longer fits a static constant. */
import { formatBps, formatRam } from "@/lib/format-bytes";

export function cpuColor(cpu: number): string {
  if (cpu > 80) return "text-error";
  if (cpu > 50) return "text-warning";
  return "text-success";
}

export function formatAge(startedAt?: number): string {
  if (!startedAt) return "";
  const secs = Math.round((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

/** `undefined` on both sides means the host cannot measure this metric for this
 *  row at all (contract: `undefined` = OS/tier cannot measure) — render an em
 *  dash rather than a misleading "0 B/s". A single defined side (e.g. read known,
 *  write not) still renders, treating the missing side as 0. */
export function formatDiskCell(readBps?: number, writeBps?: number): string {
  if (readBps === undefined && writeBps === undefined) return "—";
  return `↓ ${formatBps(readBps ?? 0)} ↑ ${formatBps(writeBps ?? 0)}`;
}

export function formatNetCell(inBps?: number, outBps?: number): string {
  if (inBps === undefined && outBps === undefined) return "—";
  return `↓ ${formatBps(inBps ?? 0)} ↑ ${formatBps(outBps ?? 0)}`;
}

/** GPU % and VRAM are measured independently on some platforms (e.g. NVIDIA
 *  consumer drivers on Linux only expose per-process memory, not per-process
 *  utilization) — each half renders its own dash when unmeasured. */
export function formatGpuCell(pct?: number, memMB?: number): string {
  if (pct === undefined && memMB === undefined) return "—";
  const pctText = pct === undefined ? "—" : `${pct.toFixed(0)}%`;
  const memText = memMB === undefined ? "—" : formatRam(memMB);
  return `${pctText} · ${memText}`;
}

/** Row-level `data-*` sort attribute for e2e/debugging: sums a disk or net pair
 *  into one comparable number, `undefined` only when NEITHER side is measured —
 *  same rule the sort comparator and the cell formatters use. */
export function sumOptionalBps(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
