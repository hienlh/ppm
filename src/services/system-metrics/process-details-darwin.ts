/**
 * The same Details dialog as `process-details-linux.ts`, for macOS.
 *
 * It exists because the dialog was *lying* there: the service answered `null`
 * for every non-Linux platform and the route turned that into a 404 reading
 * "PID <n> is no longer running" — a sentence that is correct on Linux, where a
 * vanished `/proc/<pid>` really does mean the process exited, and simply untrue
 * anywhere else. A process sitting in the table at 4.2% CPU was reported dead.
 *
 * macOS has no `/proc`, but `ps` answers ten of the eleven fields, and two of
 * them more directly than Linux does: `lstart` is a real timestamp rather than
 * jiffies to be added to `btime`, and `user` is the login name already, so no
 * `/etc/passwd` lookup is needed and it works across users. Only `cgroup` has no
 * equivalent — macOS has no such concept — and it stays null, which the page
 * draws as an em dash: the honest answer rather than an invented one.
 *
 * Measured on an M1 Max: `ps` for one pid 29.7 ms, `ps -M` 32.5 ms, `lsof` 37.5
 * ms. The last three run concurrently, so a dialog costs about two spawns' wall
 * time. That is affordable only because this is on-demand — it must never be
 * moved onto the tick, which is the same rule the Linux module states.
 */
import type { ProcessDetails } from "../../types/system-metrics.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { defaultRunner, type Runner } from "../host-info/spawn-runner.ts";

/**
 * BSD's state letters, which are NOT Linux's. The one that catches people is
 * **U**: uninterruptible wait, spelled `D` on Linux. `I` is also real here —
 * macOS marks a process idle once it has slept more than 20 seconds — and `Z`
 * is far from rare: this host had 126 zombies against 645 sleepers.
 */
export const DARWIN_PROCESS_STATES: Record<string, string> = {
  R: "Running", S: "Sleeping", I: "Idle", T: "Stopped",
  U: "Uninterruptible sleep", Z: "Zombie",
};

export interface PsFields {
  ppid: number;
  state: string | null;
  nice: number | null;
  /** Epoch ms, or 0 when `lstart` did not parse — the UI draws 0 as an em dash. */
  startedAt: number;
  user: string | null;
  exe: string | null;
}

/**
 * One line of `ps -o ppid=,stat=,nice=,lstart=,user=,comm=`, e.g.
 * `    1 S     0 Tue Sep  8 10:05:03 2026     thawng /System/…/Finder`
 *
 * Split by position, not by a delimiter, because `ps` on macOS offers none —
 * and two fields contain spaces. `lstart` is **always five tokens** (verified
 * across all 740 processes on a live host: a single-digit day pads with two
 * spaces, which collapses on a `\s+` split rather than dropping a token), so
 * every field up to `user` is at a fixed index and `comm` is whatever is left.
 * It has to be last for that reason: a path like
 * `/Applications/Google Chrome.app/…/Google Chrome Helper (Renderer)` holds six
 * spaces, so anything after it could not be found again.
 */
export function parsePsLine(text: string | null | undefined): PsFields | null {
  const line = (text ?? "").trim();
  if (!line) return null;
  const t = line.split(/\s+/);
  // ppid, stat, nice, five for lstart, user — comm may legitimately be empty.
  if (t.length < 9) return null;

  const ppid = Number(t[0]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;

  const nice = Number(t[2]);
  const started = Date.parse(t.slice(3, 8).join(" "));
  const exe = t.slice(9).join(" ");

  return {
    ppid,
    state: DARWIN_PROCESS_STATES[t[1]![0] ?? ""] ?? null,
    nice: Number.isFinite(nice) ? nice : null,
    startedAt: Number.isFinite(started) ? started : 0,
    user: t[8] || null,
    exe: exe || null,
  };
}

/**
 * Thread count from a bare `ps -M -p <pid>` dump: one header line, then one line
 * per thread.
 *
 * `-M` may not be combined with `-o` — asking for both prints the chosen columns
 * AND leftovers of the thread layout on the same line, which parses as nonsense
 * rather than failing, so this is deliberately a second call against the default
 * format rather than a column added to the first.
 */
export function parseThreadCount(text: string | null | undefined): number | null {
  const lines = (text ?? "").split("\n").filter((l) => l.trim().length > 0);
  return lines.length > 1 ? lines.length - 1 : null;
}

/**
 * `lsof -a -p <pid> -d cwd -Fn` in its machine-readable form: one field per
 * line, prefixed by its type, `n` being the name.
 *
 * Another user's working directory comes back as exit 0 with **no output at
 * all** rather than an error, which is the normal case on any machine with
 * daemons on it — the same "absent, not failed" reading the Linux module gives
 * an EACCES on `/proc/<pid>/cwd`.
 */
export function parseLsofCwd(text: string | null | undefined): string | null {
  for (const line of (text ?? "").split("\n")) {
    if (line.startsWith("n")) return line.slice(1).trim() || null;
  }
  return null;
}

/** The last path segment, for the `name` field — macOS has no `comm` truncated
 *  to 15 characters to take it from, only the executable's full path. */
function baseName(exe: string | null): string | null {
  if (!exe) return null;
  const cut = exe.lastIndexOf("/");
  return (cut >= 0 ? exe.slice(cut + 1) : exe) || null;
}

/**
 * Null when the pid is gone, which `ps` reports as a non-zero exit with nothing
 * on stdout — so the route's "no longer running" is finally true when it is said.
 */
export async function readProcessDetailsDarwin(
  pid: number,
  run: Runner = defaultRunner,
): Promise<ProcessDetails | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const arg = String(pid);

  const ps = await run(["ps", "-o", "ppid=,stat=,nice=,lstart=,user=,comm=", "-p", arg]);
  if (ps.code !== 0) return null;
  const fields = parsePsLine(ps.stdout);
  if (!fields) return null;

  // Concurrently: three independent spawns, and every one of them is allowed to
  // fail on its own. A process whose command line or thread count cannot be read
  // is still a process whose parent, user and state were just read successfully.
  const [cmd, threads, cwd] = await Promise.all([
    run(["ps", "-o", "command=", "-p", arg]),
    run(["ps", "-M", "-p", arg]),
    run(["lsof", "-a", "-p", arg, "-d", "cwd", "-Fn"]),
  ]);

  const command = cmd.code === 0 ? cmd.stdout.trim() : "";
  return {
    pid,
    ppid: fields.ppid,
    name: baseName(fields.exe) ?? arg,
    startedAt: fields.startedAt,
    // Redacted but NOT truncated, exactly as on Linux: showing the whole line is
    // what this dialog is for.
    command: command ? redactSecrets(command) : null,
    exe: fields.exe,
    cwd: cwd.code === 0 ? parseLsofCwd(cwd.stdout) : null,
    user: fields.user,
    state: fields.state,
    threads: threads.code === 0 ? parseThreadCount(threads.stdout) : null,
    nice: fields.nice,
    // macOS has no cgroups. Null is the honest answer and renders as an em dash;
    // inventing a value here would be the same mistake this file exists to undo.
    cgroup: null,
  };
}
