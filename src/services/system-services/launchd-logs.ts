/**
 * A launchd job's log. launchd keeps no journal, so this is the best there is: the
 * tail of the files the job's property list sends stdout and stderr to, and when it
 * names none PPM can read, the unified log for the job's process.
 *
 * Three things shape it, all measured:
 *
 *  - `log show` costs what it prints, not the window it is given: with a predicate
 *    naming one process, three days of a quiet daemon took 3 s, where runningboardd's
 *    758,487 lines since boot took 32 s and one chatty hour 18 s for 441,029 lines. So
 *    the last hour is read first, and the read widens to everything since the process
 *    started — since boot, for a job that is not running — only while that hour holds
 *    fewer lines than are shown. Across 50 jobs here that found lines for all 23
 *    running ones and 8 of 25 stopped ones, where a five-minute window had found 6
 *    and 0. The scans of one read share a budget, a scan that runs out is thrown away
 *    (`log show` prints oldest first, so what came before the cut is the wrong end),
 *    one read runs at a time, and stdout is read as a stream keeping the last lines.
 *  - A pid names a process only from that process's start: pids wrap at 99,999, which
 *    a desktop reached within three days here, so a query by pid over the whole boot
 *    could answer with an earlier process's lines. The start is its floor.
 *  - The file is named by the job, and a job may point it anywhere: PPM's own sends
 *    its output into `~/.ppm`. It is read through the same credential refusal as
 *    every file route (the path and its real path), only when it is a regular file —
 *    a FIFO would block the read — and only its last 64 KiB.
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { uptime } from "node:os";
import { isAbsolute } from "node:path";
import type { ServiceLogLine, ServiceLogSource } from "../../types/system-services.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";

export const MAX_LOG_LINES = 200;
export const TAIL_BYTES = 64 * 1024;
export const MAX_LINE_CHARS = 2000;
/** The window read first: on its own it fills the box for anything that logs often. */
export const RECENT_MINUTES = 60;
/** What is left to show when even the hour cannot be printed in time. */
export const FALLBACK_MINUTES = 5;
/** All the scans of one read, together. */
export const UNIFIED_LOG_BUDGET_MS = 10_000;
/** What the first scan may take of it, so that the five minutes still fit after it. */
export const RECENT_SCAN_MS = 6_000;
/** A line longer than this with no newline yet is cut: the stream stays bounded. */
const MAX_PENDING_CHARS = 64 * 1024;

export interface LaunchdLogRequest {
  stdoutPath: string | null;
  stderrPath: string | null;
  /** The running process, which the unified log is asked about first. */
  pid: number | null;
  /** When that process started, epoch ms: how far back a query by pid may reach. */
  startedAt: number | null;
  /** The executable, for a job that is not running. */
  program: string | null;
}

export interface LaunchdLog {
  lines: ServiceLogLine[];
  source: ServiceLogSource;
}

/** The real path of a job's log file when PPM may read it, else null. */
export function readableLogFile(path: string): string | null {
  if (!isAbsolute(path) || isCredentialPath(path)) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  return isCredentialPath(real) ? null : real;
}

const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);

/**
 * The last `maxLines` lines within the last `maxBytes` of a regular file. A read
 * that starts mid-file drops its first line, which is almost always partial. Opened
 * non-blocking and checked after opening, so a FIFO or a device is refused rather
 * than read, and nothing can swap the file between a check and the read.
 */
export function tailLines(path: string, maxBytes: number = TAIL_BYTES, maxLines: number = MAX_LOG_LINES): string[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return [];
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines).map((line) => clip(line.replace(/\r$/, "")));
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** A string literal in an NSPredicate. */
const predicateString = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * What to ask the unified log for: the running process by pid, else the job's
 * executable by the path it runs from — its real path, since Homebrew's `bin` links
 * into the Cellar and the log records where the image actually is.
 */
export function unifiedLogPredicate(pid: number | null, program: string | null): string | null {
  if (pid !== null) return `processID == ${pid}`;
  if (!program || !isAbsolute(program)) return null;
  let image = program;
  try {
    image = realpathSync(program);
  } catch {
    // Not there any more: ask by the path the job names.
  }
  return `processImagePath == ${predicateString(image)}`;
}

/** Everything from `startMs` on; `log` takes whole seconds as `@unixtime`. */
export function unifiedLogArgv(predicate: string, startMs: number): string[] {
  return ["/usr/bin/log", "show", "--start", `@${Math.floor(startMs / 1000)}`, "--style", "ndjson", "--predicate", predicate];
}

export interface LogWindow {
  startMs: number;
  source: ServiceLogSource;
}

export interface LogWindows {
  /** Read first. */
  recent: LogWindow;
  /** Read when `recent` holds fewer lines than are shown; null when `recent` is all of it. */
  full: LogWindow | null;
  /** Read instead when `recent` cannot be printed in time. */
  fallback: LogWindow;
}

/**
 * The windows of one read. The floor is where the log stops being this job's: the
 * process's start for a query by pid, the boot for one by executable. A running
 * process whose start is unknown has no floor and is never read past the hour, since
 * earlier lines under its pid may be another process's.
 */
export function logWindows(pid: number | null, startedAt: number | null, now: number, bootedAt: number): LogWindows {
  const floor = pid !== null ? startedAt : bootedAt;
  const since = (minutes: number) => (floor === null ? now - minutes * 60_000 : Math.max(now - minutes * 60_000, floor));
  const recent: LogWindow = { startMs: since(RECENT_MINUTES), source: { kind: "unified", minutes: RECENT_MINUTES } };
  const fallback: LogWindow = { startMs: since(FALLBACK_MINUTES), source: { kind: "unified", minutes: FALLBACK_MINUTES } };
  if (floor === null) return { recent, full: null, fallback };
  const full: LogWindow = { startMs: floor, source: { kind: "unified", since: pid !== null ? "start" : "boot" } };
  // A floor inside the hour: the hour is all there is.
  return floor >= recent.startMs ? { recent: full, full: null, fallback } : { recent, full, fallback };
}

/** "2026-09-30 15:18:03.753763+0100" → epoch ms. */
export function parseLogTimestamp(ts: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(\d{2})$/.exec(ts);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}${m[4]}:${m[5]}`);
  return Number.isFinite(ms) ? ms : null;
}

/** One `--style ndjson` line, or null for anything that is not a message — the
 *  closing `{"count":N,"finished":1}` among them. */
export function parseUnifiedLogLine(line: string): ServiceLogLine | null {
  let entry: { timestamp?: unknown; eventMessage?: unknown };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof entry?.eventMessage !== "string" || typeof entry.timestamp !== "string") return null;
  return { ts: parseLogTimestamp(entry.timestamp), message: clip(entry.eventMessage) };
}

export interface LineTail {
  /** The last lines the process wrote, oldest first. */
  lines: string[];
  timedOut: boolean;
}

/** Runs argv and keeps only the last `keep` lines of its stdout. */
export type LineTailRunner = (argv: string[], timeoutMs: number, keep: number) => Promise<LineTail>;

const spawnTail = (argv: string[]) => Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });

/** A ring of the last lines, so a run printing half a million of them holds `keep`. */
export const defaultLineTailRunner: LineTailRunner = async (argv, timeoutMs, keep) => {
  let proc: ReturnType<typeof spawnTail>;
  try {
    proc = spawnTail(argv);
  } catch {
    // Not installed: the same "nothing to show" as a run that printed nothing.
    return { lines: [], timedOut: false };
  }
  const ring = new Array<string>(keep);
  let count = 0;
  const push = (line: string) => {
    ring[count % keep] = line;
    count++;
  };

  let timedOut = false;
  let giveUp!: () => void;
  const abandoned = new Promise<void>((resolve) => { giveUp = resolve; });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
    giveUp();
  }, timeoutMs);

  const drain = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parts = (pending + decoder.decode(value, { stream: true })).split("\n");
      pending = parts.pop()!.slice(0, MAX_PENDING_CHARS);
      for (const part of parts) push(part);
    }
    if (pending) push(pending);
  };
  try {
    await Promise.race([drain().catch(() => {}), abandoned]);
  } finally {
    clearTimeout(timer);
  }
  const kept = Math.min(count, keep);
  const lines: string[] = [];
  for (let i = count - kept; i < count; i++) lines.push(ring[i % keep]!);
  return { lines, timedOut };
};

export interface LaunchdLogReader {
  read(req: LaunchdLogRequest): Promise<LaunchdLog>;
}

export interface LogClock {
  now(): number;
  /** When the machine booted, epoch ms. */
  bootedAt(): number;
}

const systemClock: LogClock = { now: () => Date.now(), bootedAt: () => Date.now() - uptime() * 1000 };

export function createLaunchdLogReader(tail: LineTailRunner = defaultLineTailRunner, clock: LogClock = systemClock): LaunchdLogReader {
  /** Two scans at once only make both slow, and a second one is usually the same
   *  dialog opened again. */
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const scan = async (predicate: string, window: LogWindow, timeoutMs: number) => {
    // One more than kept: the last line of a finished run is its summary.
    const out = await tail(unifiedLogArgv(predicate, window.startMs), timeoutMs, MAX_LOG_LINES + 1);
    const lines = out.lines.map(parseUnifiedLogLine).filter((l): l is ServiceLogLine => l !== null);
    return { lines: lines.slice(-MAX_LOG_LINES), timedOut: out.timedOut };
  };

  /** The newest window first, a wider one only while the box is not full. */
  const readUnified = async (predicate: string, windows: LogWindows): Promise<LaunchdLog> => {
    const deadline = clock.now() + UNIFIED_LOG_BUDGET_MS;
    const left = () => Math.max(0, deadline - clock.now());
    const recent = await scan(predicate, windows.recent, RECENT_SCAN_MS);
    if (recent.timedOut) {
      // The last resort keeps what it printed: lines from the last five minutes, if
      // not the newest of them, say more than an empty box.
      const last = await scan(predicate, windows.fallback, left());
      return { lines: last.lines, source: windows.fallback.source };
    }
    const { full } = windows;
    if (!full) return { lines: recent.lines, source: windows.recent.source };
    // A full box from the hour is also the newest lines since the floor.
    if (recent.lines.length >= MAX_LOG_LINES) return { lines: recent.lines, source: full.source };
    const all = await scan(predicate, full, left());
    return all.timedOut ? { lines: recent.lines, source: windows.recent.source } : { lines: all.lines, source: full.source };
  };

  return {
    async read(req) {
      const reals = new Map<string, string>();
      for (const path of [req.stdoutPath, req.stderrPath]) {
        const real = path ? readableLogFile(path) : null;
        // stdout and stderr are commonly one file: read it once.
        if (path && real && ![...reals.values()].includes(real)) reals.set(path, real);
      }
      if (reals.size > 0) {
        const each = Math.floor(MAX_LOG_LINES / reals.size);
        return {
          lines: [...reals.values()].flatMap((real) => tailLines(real, TAIL_BYTES, each).map((message) => ({ ts: null, message }))),
          source: { kind: "files", paths: [...reals.keys()] },
        };
      }

      const windows = logWindows(req.pid, req.startedAt, clock.now(), clock.bootedAt());
      const predicate = unifiedLogPredicate(req.pid, req.program);
      if (!predicate) return { lines: [], source: (windows.full ?? windows.recent).source };
      return serialised(() => readUnified(predicate, windows));
    },
  };
}
