/**
 * On-demand facts for the process Details dialog — Mission Center's process
 * properties. Fetched when the dialog opens, never per tick: it is a handful of
 * reads per process and nobody needs `cwd` at 0.5 Hz.
 *
 * Every field is null when this pid's permissions do not expose it. Another
 * user's `exe` and `cwd` are EACCES for an unprivileged PPM, which is the normal
 * case on a shared machine and not an error.
 */
import type { ProcessDetails } from "../../types/system-metrics.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { readAttr, realLinuxFs, type LinuxFs } from "./linux-fs.ts";

const PROC = "/proc";
/** Same assumption `proc-table-linux.ts` documents: 100 on every mainstream Linux. */
const CLOCK_TICKS_PER_SEC = 100;

/** The kernel's one-letter state, spelled out the way `ps` and Mission Center do. */
export const PROCESS_STATES: Record<string, string> = {
  R: "Running", S: "Sleeping", D: "Uninterruptible sleep", Z: "Zombie",
  T: "Stopped", t: "Tracing stop", X: "Dead", I: "Idle", W: "Paging", K: "Wakekill",
};

export interface StatFields {
  state: string;
  ppid: number;
  nice: number;
  threads: number;
  /** Ticks since boot. */
  startTicks: number;
  comm: string;
}

/**
 * `/proc/<pid>/stat`, anchored on the LAST `)`.
 *
 * The second field is the executable name in parentheses and it is not escaped,
 * so a process called `foo) 0 (bar` shifts every field after it for any parser
 * that splits on whitespace. Anchoring on the last `)` is the only correct
 * reading, and it is what `readProcTable` does too.
 */
export function parseStatFields(text: string): StatFields | null {
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (close < 0 || open < 0 || close < open) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // `rest[0]` is field 3 (state), so field N is at rest[N - 3].
  const at = (field: number) => Number(rest[field - 3]);
  const ppid = at(4);
  if (!Number.isFinite(ppid)) return null;
  return {
    comm: text.slice(open + 1, close),
    state: rest[0] ?? "",
    ppid,
    nice: at(19),
    threads: at(20),
    startTicks: at(22),
  };
}

/** `/proc/stat`'s `btime` line: boot time as epoch SECONDS. */
export function parseBootTimeSec(procStat: string | null): number | null {
  const m = /^btime\s+(\d+)/m.exec(procStat ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The real uid from `/proc/<pid>/status`'s `Uid: real effective saved fs`. */
export function parseUid(status: string | null): number | null {
  const m = /^Uid:\s+(\d+)/m.exec(status ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** uid → login name from `/etc/passwd`, which is world-readable by design. */
export function lookupUser(uid: number, passwd: string | null): string | null {
  for (const line of (passwd ?? "").split("\n")) {
    const f = line.split(":");
    if (f.length > 2 && Number(f[2]) === uid) return f[0] ?? null;
  }
  return null;
}

/** cgroup v2 writes one `0::<path>` line; v1 writes several, and the systemd
 *  hierarchy is the one that names the unit. */
export function parseCgroup(text: string | null): string | null {
  const lines = (text ?? "").split("\n").filter(Boolean);
  const v2 = lines.find((l) => l.startsWith("0::"));
  if (v2) return v2.slice(3) || null;
  const systemd = lines.find((l) => l.includes(":name=systemd:"));
  const chosen = systemd ?? lines[0];
  if (!chosen) return null;
  const idx = chosen.indexOf(":", chosen.indexOf(":") + 1);
  return idx >= 0 ? chosen.slice(idx + 1) || null : null;
}

export interface ProcessDetailsOptions {
  fs?: LinuxFs;
  /** Injected so the lookup is testable and read once per request, not per line. */
  passwd?: () => string | null;
}

/** Null when the pid is gone (or /proc is unreadable) — the dialog then says so. */
export function readProcessDetails(pid: number, opts: ProcessDetailsOptions = {}): ProcessDetails | null {
  const fs = opts.fs ?? realLinuxFs;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = fs.read(`${PROC}/${pid}/stat`);
  const fields = stat ? parseStatFields(stat) : null;
  if (!fields) return null;

  const status = fs.read(`${PROC}/${pid}/status`);
  const uid = parseUid(status);
  const bootSec = parseBootTimeSec(fs.read(`${PROC}/stat`));
  const rawCmdline = fs.read(`${PROC}/${pid}/cmdline`) ?? "";
  // NUL-separated argv. A kernel thread has an empty cmdline, which is not a
  // command line of "" — it has none at all.
  const argv = rawCmdline.split("\0").filter(Boolean).join(" ");

  return {
    pid,
    ppid: fields.ppid,
    name: nameOf(status) ?? fields.comm,
    startedAt: bootSec !== null && Number.isFinite(fields.startTicks)
      ? Math.round((bootSec + fields.startTicks / CLOCK_TICKS_PER_SEC) * 1000)
      : 0,
    // Redacted but NOT truncated: the dialog exists to show the whole line, and
    // the 160-char cut on a table row is a bandwidth decision, not a privacy one.
    command: argv ? redactSecrets(argv) : null,
    exe: fs.readlink(`${PROC}/${pid}/exe`),
    cwd: fs.readlink(`${PROC}/${pid}/cwd`),
    user: uid === null ? null : lookupUser(uid, (opts.passwd ?? (() => fs.read("/etc/passwd")))()),
    state: describeState(fields.state),
    threads: Number.isFinite(fields.threads) ? fields.threads : null,
    nice: Number.isFinite(fields.nice) ? fields.nice : null,
    cgroup: parseCgroup(fs.read(`${PROC}/${pid}/cgroup`)),
  };
}

/** `/proc/<pid>/status`'s `Name:` is the same truncated comm, but without the
 *  parenthesis quoting — preferred when present because it needs no unwrapping. */
function nameOf(status: string | null): string | null {
  const m = /^Name:\s*(.+)$/m.exec(status ?? "");
  return m?.[1]?.trim() || null;
}

export function describeState(code: string): string | null {
  if (!code) return null;
  const word = PROCESS_STATES[code];
  return word ? `${code} (${word})` : code;
}
