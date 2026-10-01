/**
 * Per-process swap — Mission Center's Swap column, on the process table and on
 * every Services row.
 *
 * `VmSwap` in `/proc/<pid>/status` is the only cheap source: `smaps_rollup` also
 * carries it but walks every mapping, and on a 560-process desktop that is the
 * difference between a few milliseconds and a tick that misses its deadline.
 * Measured here: the whole table costs 3.2 ms, beside the 1.7 ms `/proc/<pid>/io`
 * already pays every tick.
 *
 * A kernel thread has no address space and so no `VmSwap` line at all. That is
 * 0 swapped bytes, not an unmeasurable one — the distinction matters because the
 * table renders `undefined` as an em dash, and 335 of this host's 561 rows would
 * otherwise be dashes on a column that really does read zero for them.
 */
import { readFileSync } from "node:fs";

const KB_PER_MB = 1024;

/** `VmSwap` in kB from a `/proc/<pid>/status` dump. A process with an address
 *  space always has the line; one without is a kernel thread, i.e. 0. */
export function parseVmSwapKB(status: string): number {
  const m = /^VmSwap:\s+(\d+)\s*kB/m.exec(status);
  if (!m) return 0;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb : 0;
}

/** Swapped MB for one pid, or null when the process is gone or unreadable —
 *  another user's process is expected to refuse, and that row simply has none. */
export function readProcSwapMB(pid: number): number | null {
  try {
    return parseVmSwapKB(readFileSync(`/proc/${pid}/status`, "utf-8")) / KB_PER_MB;
  } catch {
    return null;
  }
}
