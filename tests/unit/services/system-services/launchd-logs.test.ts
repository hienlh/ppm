/** A launchd job's log: the tail of its own files, else a bounded unified-log query. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  createLaunchdLogReader, defaultLineTailRunner, FALLBACK_MINUTES, logWindows, MAX_LINE_CHARS, MAX_LOG_LINES,
  parseLogTimestamp, parseUnifiedLogLine, readableLogFile, RECENT_MINUTES, RECENT_SCAN_MS, tailLines,
  UNIFIED_LOG_BUDGET_MS, unifiedLogArgv, unifiedLogPredicate, type LineTailRunner, type LogClock,
} from "../../../../src/services/system-services/launchd-logs.ts";

let dir = "";
let insidePpm = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-launchd-logs-"));
  insidePpm = join(getPpmDir(), "ppm-launchd-test.log");
  writeFileSync(insidePpm, "token=secret\n");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(insidePpm, { force: true });
});

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

describe("readableLogFile", () => {
  test("a job's own log file, by its real path", () => {
    const file = join(dir, "agent.log");
    writeFileSync(file, "hello\n");
    expect(readableLogFile(file)).toMatch(/agent\.log$/);
  });

  test("PPM's own directory is refused, however the path reaches it", () => {
    expect(readableLogFile(insidePpm)).toBeNull();
    const link = join(dir, "innocent.log");
    symlinkSync(insidePpm, link);
    expect(readableLogFile(link)).toBeNull();
  });

  test("a relative or missing path is nothing to read", () => {
    expect(readableLogFile("agent.log")).toBeNull();
    expect(readableLogFile(join(dir, "missing.log"))).toBeNull();
  });
});

describe("tailLines", () => {
  test("the last lines, oldest first", () => {
    const file = join(dir, "many.log");
    writeFileSync(file, lines(500));
    expect(tailLines(file, 1 << 20, 3)).toEqual(["line 497", "line 498", "line 499"]);
  });

  test("a read that starts mid-file drops the partial line it starts in", () => {
    const file = join(dir, "big.log");
    writeFileSync(file, lines(1000));
    const got = tailLines(file, 100, 1000);
    expect(got[got.length - 1]).toBe("line 999");
    expect(got.every((line) => /^line \d+$/.test(line))).toBe(true);
  });

  test("CRLF endings and endless lines are tidied", () => {
    const file = join(dir, "odd.log");
    writeFileSync(file, `dos line\r\n${"x".repeat(MAX_LINE_CHARS + 50)}\n`);
    const [dos, long] = tailLines(file);
    expect(dos).toBe("dos line");
    expect(long!.length).toBe(MAX_LINE_CHARS + 1);
    expect(long!.endsWith("…")).toBe(true);
  });

  test.if(process.platform !== "win32")("a FIFO is refused instead of blocking the server", () => {
    const fifo = join(dir, "pipe.log");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const started = performance.now();
    expect(tailLines(fifo)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("the unified log query", () => {
  test("by pid while the job runs", () => {
    expect(unifiedLogPredicate(181, "/usr/sbin/mDNSResponder")).toBe("processID == 181");
  });

  test("by executable when it does not, with the path quoted as a predicate string", () => {
    expect(unifiedLogPredicate(null, '/opt/odd "name"\\bin')).toBe('processImagePath == "/opt/odd \\"name\\"\\\\bin"');
    expect(unifiedLogPredicate(null, "relative/bin")).toBeNull();
    expect(unifiedLogPredicate(null, null)).toBeNull();
  });

  test("by the executable's real path, which is where the log says the image is", () => {
    const real = join(dir, "real-bin");
    const link = join(dir, "linked-bin");
    writeFileSync(real, "");
    symlinkSync(real, link);
    expect(unifiedLogPredicate(null, link)).toMatch(/real-bin"$/);
  });

  test("from a moment on, in the whole seconds `log` takes, one line per entry", () => {
    expect(unifiedLogArgv("processID == 1", 1_790_565_581_649)).toEqual([
      "/usr/bin/log", "show", "--start", "@1790565581", "--style", "ndjson", "--predicate", "processID == 1",
    ]);
  });

  test("an entry becomes a timed line, and the closing summary becomes nothing", () => {
    const entry = JSON.stringify({ timestamp: "2026-09-30 15:18:03.753763+0100", eventMessage: "ready", eventType: "logEvent" });
    expect(parseUnifiedLogLine(entry)).toEqual({ ts: Date.UTC(2026, 8, 30, 14, 18, 3, 753), message: "ready" });
    expect(parseUnifiedLogLine('{"count":75590,"finished":1}')).toBeNull();
    expect(parseUnifiedLogLine("not json")).toBeNull();
    expect(parseLogTimestamp("yesterday")).toBeNull();
  });
});

const NOW = Date.UTC(2026, 9, 1, 2, 0, 0);
const BOOT = NOW - 70 * 3_600_000;
const MIN = 60_000;

describe("the windows of one read", () => {
  test("a running job: the hour, then everything since its process started", () => {
    const started = NOW - 30 * 3_600_000;
    expect(logWindows(42, started, NOW, BOOT)).toEqual({
      recent: { startMs: NOW - RECENT_MINUTES * MIN, source: { kind: "unified", minutes: RECENT_MINUTES } },
      full: { startMs: started, source: { kind: "unified", since: "start" } },
      fallback: { startMs: NOW - FALLBACK_MINUTES * MIN, source: { kind: "unified", minutes: FALLBACK_MINUTES } },
    });
  });

  test("a job that is not running: since boot", () => {
    expect(logWindows(null, null, NOW, BOOT).full).toEqual({ startMs: BOOT, source: { kind: "unified", since: "boot" } });
  });

  test("a process younger than the hour is one window, and nothing before it is asked for", () => {
    const started = NOW - 3 * MIN;
    const w = logWindows(42, started, NOW, BOOT);
    expect(w.recent).toEqual({ startMs: started, source: { kind: "unified", since: "start" } });
    expect(w.full).toBeNull();
    expect(w.fallback.startMs).toBe(started);
  });

  test("a running process whose start is unknown is never read past the hour", () => {
    const w = logWindows(42, null, NOW, BOOT);
    expect(w.recent.startMs).toBe(NOW - RECENT_MINUTES * MIN);
    expect(w.full).toBeNull();
  });
});

describe("defaultLineTailRunner", () => {
  test("keeps only the last lines of a run that prints thousands", async () => {
    const out = await defaultLineTailRunner(
      [process.execPath, "-e", "for (let i = 0; i < 5000; i++) console.log('entry ' + i)"],
      10_000,
      3,
    );
    expect(out).toEqual({ lines: ["entry 4997", "entry 4998", "entry 4999"], timedOut: false });
  });

  test("gives up at its timeout, keeping what came before it", async () => {
    const started = performance.now();
    const out = await defaultLineTailRunner(
      [process.execPath, "-e", "console.log('first'); setTimeout(() => {}, 30000)"],
      1500,
      5,
    );
    expect(out.timedOut).toBe(true);
    expect(out.lines).toEqual(["first"]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("a tool that is not installed is nothing to show, not an exception", async () => {
    expect(await defaultLineTailRunner(["ppm-no-such-tool-anywhere"], 1000, 5)).toEqual({ lines: [], timedOut: false });
  });
});

describe("createLaunchdLogReader", () => {
  const entry = (i: number) => JSON.stringify({ timestamp: "2026-09-30 15:18:03.000000+0000", eventMessage: `m${i}` });

  function fakeLog(delayMs = 0, entries = 300) {
    const calls: string[][] = [];
    let running = 0;
    let most = 0;
    const tail: LineTailRunner = async (argv, _timeout, keep) => {
      calls.push(argv);
      most = Math.max(most, ++running);
      if (delayMs) await Bun.sleep(delayMs);
      running--;
      const all = [...Array.from({ length: entries }, (_, i) => entry(i)), `{"count":${entries},"finished":1}`];
      return { lines: all.slice(-keep), timedOut: false };
    };
    return { tail, calls, most: () => most };
  }
  const twoHoursAgo = () => Date.now() - 2 * 3_600_000;

  test("a job that logs to one file for both streams reads it once", async () => {
    const file = join(dir, "both.log");
    writeFileSync(file, "one\ntwo\n");
    const log = fakeLog();
    const got = await createLaunchdLogReader(log.tail).read({ stdoutPath: file, stderrPath: file, pid: 5, startedAt: null, program: null });
    expect(got).toEqual({
      lines: [{ ts: null, message: "one" }, { ts: null, message: "two" }],
      source: { kind: "files", paths: [file] },
    });
    expect(log.calls).toEqual([]);
  });

  test("two files share the line budget", async () => {
    const out = join(dir, "out.log");
    const err = join(dir, "err.log");
    writeFileSync(out, lines(300, "out"));
    writeFileSync(err, lines(300, "err"));
    const got = await createLaunchdLogReader(fakeLog().tail).read({ stdoutPath: out, stderrPath: err, pid: null, startedAt: null, program: null });
    expect(got.lines).toHaveLength(MAX_LOG_LINES);
    expect(got.lines[0]!.message).toBe("out 200");
    expect(got.lines[MAX_LOG_LINES - 1]!.message).toBe("err 299");
  });

  test("a file PPM may not read falls through to the unified log", async () => {
    const log = fakeLog();
    const got = await createLaunchdLogReader(log.tail).read({
      stdoutPath: insidePpm, stderrPath: null, pid: 42, startedAt: twoHoursAgo(), program: null,
    });
    expect(got.source).toEqual({ kind: "unified", since: "start" });
    expect(log.calls[0]).toContain("processID == 42");
    expect(got.lines).toHaveLength(MAX_LOG_LINES);
    expect(got.lines[MAX_LOG_LINES - 1]).toEqual({ ts: Date.UTC(2026, 8, 30, 15, 18, 3), message: "m299" });
    expect(got.lines.some((l) => l.message.includes("secret"))).toBe(false);
  });

  test("nothing to ask the unified log about is an empty log, not a query", async () => {
    const log = fakeLog();
    const got = await createLaunchdLogReader(log.tail).read({ stdoutPath: null, stderrPath: null, pid: null, startedAt: null, program: "bun" });
    expect(got).toEqual({ lines: [], source: { kind: "unified", since: "boot" } });
    expect(log.calls).toEqual([]);
  });

  test("one scan of the store at a time, a read's second scan included", async () => {
    // Ten lines in the hour: every read widens, so each one scans twice.
    const log = fakeLog(30, 10);
    const reader = createLaunchdLogReader(log.tail);
    const req = { stdoutPath: null, stderrPath: null, pid: 7, startedAt: twoHoursAgo(), program: null };
    await Promise.all([reader.read(req), reader.read(req), reader.read(req)]);
    expect(log.calls).toHaveLength(6);
    expect(log.most()).toBe(1);
  });
});

describe("reading the unified log, newest window first", () => {
  const STARTED = NOW - 30 * 3_600_000;
  const at = (i: number) => JSON.stringify({ timestamp: "2026-10-01 01:59:00.000000+0000", eventMessage: `m${i}` });
  const startOf = (argv: string[]) => Number(argv[argv.indexOf("--start") + 1]!.slice(1)) * 1000;

  /** Answers each scan in turn; a scan may take time on the fake clock, or run out. */
  function scripted(...answers: { lines: number; timedOut?: boolean; takesMs?: number }[]) {
    let t = NOW;
    const clock: LogClock = { now: () => t, bootedAt: () => BOOT };
    const scans: { start: number; timeoutMs: number }[] = [];
    const tail: LineTailRunner = async (argv, timeoutMs, keep) => {
      const a = answers[scans.length] ?? { lines: 0 };
      scans.push({ start: startOf(argv), timeoutMs });
      t += a.takesMs ?? 0;
      const out = Array.from({ length: a.lines }, (_, i) => at(i));
      if (!a.timedOut) out.push(`{"count":${a.lines},"finished":1}`);
      return { lines: out.slice(-keep), timedOut: a.timedOut ?? false };
    };
    return { reader: createLaunchdLogReader(tail, clock), scans };
  }
  const running = { stdoutPath: null, stderrPath: null, pid: 42, startedAt: STARTED, program: null };

  test("a quiet job: the hour, then everything since its process started, within the budget", async () => {
    const { reader, scans } = scripted({ lines: 12, takesMs: 900 }, { lines: 40 });
    const got = await reader.read(running);
    expect(scans).toEqual([
      { start: NOW - RECENT_MINUTES * MIN, timeoutMs: RECENT_SCAN_MS },
      { start: STARTED, timeoutMs: UNIFIED_LOG_BUDGET_MS - 900 },
    ]);
    expect(got.lines).toHaveLength(40);
    expect(got.source).toEqual({ kind: "unified", since: "start" });
  });

  test("a busy job stops at the hour, which already holds the newest lines since it started", async () => {
    const { reader, scans } = scripted({ lines: 5000 });
    const got = await reader.read(running);
    expect(scans).toHaveLength(1);
    expect(got.lines).toHaveLength(MAX_LOG_LINES);
    expect(got.lines[MAX_LOG_LINES - 1]!.message).toBe("m4999");
    expect(got.source).toEqual({ kind: "unified", since: "start" });
  });

  test("a process younger than the hour is one scan from its start", async () => {
    const { reader, scans } = scripted({ lines: 3 });
    const got = await reader.read({ ...running, startedAt: NOW - 10 * MIN });
    expect(scans).toEqual([{ start: NOW - 10 * MIN, timeoutMs: RECENT_SCAN_MS }]);
    expect(got.source).toEqual({ kind: "unified", since: "start" });
  });

  test("a job that is not running is read since boot, by its executable", async () => {
    const program = join(dir, "stopped-daemon");
    writeFileSync(program, "");
    const { reader, scans } = scripted({ lines: 0 }, { lines: 3 });
    const got = await reader.read({ stdoutPath: null, stderrPath: null, pid: null, startedAt: null, program });
    expect(scans.map((s) => s.start)).toEqual([NOW - RECENT_MINUTES * MIN, BOOT]);
    expect(got.lines).toHaveLength(3);
    expect(got.source).toEqual({ kind: "unified", since: "boot" });
  });

  test("when the whole run cannot be printed in time, the hour is what shows, and says so", async () => {
    const { reader } = scripted({ lines: 12, takesMs: 1_000 }, { lines: 150, timedOut: true });
    const got = await reader.read(running);
    expect(got.lines).toHaveLength(12);
    expect(got.source).toEqual({ kind: "unified", minutes: RECENT_MINUTES });
  });

  test("when even the hour is too much, the last five minutes, in what is left of the budget", async () => {
    const { reader, scans } = scripted({ lines: 150, timedOut: true, takesMs: RECENT_SCAN_MS }, { lines: 30 });
    const got = await reader.read(running);
    expect(scans[1]).toEqual({ start: NOW - FALLBACK_MINUTES * MIN, timeoutMs: UNIFIED_LOG_BUDGET_MS - RECENT_SCAN_MS });
    expect(got.lines).toHaveLength(30);
    expect(got.source).toEqual({ kind: "unified", minutes: FALLBACK_MINUTES });
  });
});
