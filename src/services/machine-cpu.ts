/**
 * How busy the whole machine's CPUs were between two readings.
 *
 * A process that got little CPU during a stall was either *starved* (every core was
 * busy with someone else) or *blocked* (cores were free, and it was waiting on a disk
 * read, a page-in, a lock or a child process). Its own CPU time cannot tell the two
 * apart; the machine's can.
 */
import { cpus } from "node:os";

export interface MachineCpuTimes {
  /** Sum over every core of time spent not idle, in ms. */
  busy: number;
  /** Sum over every core of all time, in ms. */
  total: number;
}

export function readMachineCpuTimes(): MachineCpuTimes | null {
  try {
    let busy = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      const all = t.user + t.nice + t.sys + t.idle + t.irq;
      total += all;
      busy += all - t.idle;
    }
    return total > 0 ? { busy, total } : null;
  } catch {
    return null;
  }
}

/** Share of all cores that were busy between `a` and `b`, 0-1; null when it cannot be told. */
export function machineBusyFraction(a: MachineCpuTimes | null, b: MachineCpuTimes | null): number | null {
  if (!a || !b) return null;
  const total = b.total - a.total;
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, (b.busy - a.busy) / total));
}
