/**
 * Process table straight from `/proc` — Linux only, no subprocess.
 *
 * Every caller in PPM used to shell out to `ps`, which lives in `procps` and is
 * simply absent from slim Debian images (including the one PPM's own test suite
 * runs in). Each call site swallowed the spawn error and carried on with empty
 * data, so a missing binary silently disabled orphan reaping, resource graphs
 * and cloudflared discovery instead of failing loudly.
 *
 * Callers keep `ps` as the macOS path; there is no `/proc` there.
 */
import { readFileSync, readdirSync } from "node:fs";

export const PROC_AVAILABLE = process.platform === "linux";

/**
 * Kernel clock ticks per second. `sysconf(_SC_CLK_TCK)` is not reachable from
 * JS; 100 is the value Linux has shipped on every mainstream configuration for
 * decades, and it only scales CPU-time maths, so a wrong guess would skew a
 * percentage rather than break anything.
 */
const CLOCK_TICKS_PER_SEC = 100;
/** `/proc/<pid>/stat` reports RSS in pages. */
const PAGE_SIZE_KB = 4;

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** Average CPU% over the process lifetime — the same figure `ps %cpu` prints. */
  cpuPercent: number;
  rssKB: number;
  /** Seconds since the process started. */
  elapsedSec: number;
  /** Wall-clock start time, epoch ms. Stable identity for PID-reuse checks. */
  startedAtMs: number;
  /** Executable name from `comm` (truncated to 15 chars by the kernel). */
  comm: string;
  /** Full argv joined by spaces. Empty for kernel threads. */
  args: string;
}

/** Lowercased argv of `pid`, or null when /proc is unavailable/unreadable. */
export function readProcCmdline(pid: number): string | null {
  if (!PROC_AVAILABLE) return null;
  try {
    // NUL-separated argv; join with spaces so substring checks behave like `ps`.
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ").toLowerCase();
  } catch {
    return null;
  }
}

/** Kernel `comm` for `pid`, or null when /proc is unavailable/unreadable. */
export function readProcComm(pid: number): string | null {
  if (!PROC_AVAILABLE) return null;
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
  } catch {
    return null;
  }
}

/** pid → ppid for every visible process, or null when /proc is unavailable. */
export function readProcPpidMap(): Map<number, number> | null {
  if (!PROC_AVAILABLE) return null;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return null;
  }
  const ppidOf = new Map<number, number>();
  for (const name of names) {
    if (!isPidDir(name)) continue;
    const fields = readStatFields(Number(name));
    if (fields) ppidOf.set(Number(name), fields.ppid);
  }
  return ppidOf.size > 0 ? ppidOf : null;
}

/**
 * Full process table, or null when /proc is unavailable. Reads `/proc/uptime`
 * and `/proc/stat` once and reuses them for every process, so a table of a few
 * hundred processes costs a few hundred small reads and no process spawns.
 */
export function readProcTable(): ProcEntry[] | null {
  if (!PROC_AVAILABLE) return null;

  let names: string[];
  let uptimeSec: number;
  let bootTimeMs: number;
  try {
    names = readdirSync("/proc");
    uptimeSec = parseFloat(readFileSync("/proc/uptime", "utf-8").split(/\s+/)[0] ?? "");
    const btime = readFileSync("/proc/stat", "utf-8").match(/^btime\s+(\d+)/m);
    bootTimeMs = btime ? Number(btime[1]) * 1000 : Date.now() - uptimeSec * 1000;
  } catch {
    return null;
  }
  if (!Number.isFinite(uptimeSec)) return null;

  const out: ProcEntry[] = [];
  for (const name of names) {
    if (!isPidDir(name)) continue;
    const pid = Number(name);
    const f = readStatFields(pid);
    if (!f) continue;

    const startSec = f.startTicks / CLOCK_TICKS_PER_SEC;
    // Clamp: a process started in the same tick as the uptime read can compute
    // a tiny negative elapsed, which would produce an absurd CPU percentage.
    const elapsedSec = Math.max(uptimeSec - startSec, 0.001);
    const cpuSec = (f.utime + f.stime) / CLOCK_TICKS_PER_SEC;

    let args = "";
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean).join(" ");
    } catch { /* exited between readdir and read */ }

    out.push({
      pid,
      ppid: f.ppid,
      cpuPercent: Math.round((cpuSec / elapsedSec) * 1000) / 10,
      rssKB: f.rssPages * PAGE_SIZE_KB,
      elapsedSec,
      startedAtMs: bootTimeMs + startSec * 1000,
      comm: f.comm,
      args,
    });
  }
  return out.length > 0 ? out : null;
}

const isPidDir = (name: string): boolean => /^\d+$/.test(name);

interface StatFields {
  comm: string;
  ppid: number;
  utime: number;
  stime: number;
  startTicks: number;
  rssPages: number;
}

/**
 * Parse the fields we need out of `/proc/<pid>/stat`.
 *
 * The format is `pid (comm) state ppid …` and `comm` may contain spaces AND
 * parentheses, so the split has to anchor on the LAST ')' — a naive
 * whitespace split silently shifts every field for any process whose name
 * contains a space.
 */
function readStatFields(pid: number): StatFields | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null; // process exited, or not permitted
  }
  const close = stat.lastIndexOf(")");
  const open = stat.indexOf("(");
  if (close < 0 || open < 0 || close < open) return null;

  const comm = stat.slice(open + 1, close);
  // After the last ')' the fields are: state ppid pgrp … i.e. proc(5) field N
  // sits at index N-3.
  const f = stat.slice(close + 1).trim().split(/\s+/);
  const num = (i: number): number => {
    const v = parseInt(f[i] ?? "", 10);
    return isNaN(v) ? 0 : v;
  };
  const ppid = parseInt(f[1] ?? "", 10);
  if (isNaN(ppid)) return null;

  return {
    comm,
    ppid,
    utime: num(11),      // field 14
    stime: num(12),      // field 15
    startTicks: num(19), // field 22
    rssPages: num(21),   // field 24
  };
}
