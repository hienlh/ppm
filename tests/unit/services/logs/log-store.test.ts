/**
 * The Logs reader against real files: how `ppm.log` lines become records, how filters, search
 * and paging pick a page, how ids survive rotation, and what the live tail hands out.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch, lastTraceRowid, recordTraceDevice } from "../../../../src/services/session-trace/session-trace-store.ts";
import {
  _resetLogStoreForTests, MAX_REACH, queryLogs, REACH_CONTEXT, readAround, readNewEntries, readProblems, restartTimes,
} from "../../../../src/services/logs/log-store.ts";
import { LogFileIndex } from "../../../../src/services/logs/log-file-index.ts";
import { DEFAULT_LOG_FILTER, type LogEntry } from "../../../../src/shared/logs-model.ts";
import type { LogQueryParams } from "../../../../src/shared/logs-api.ts";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;
let home = "";

const T0 = Date.parse("2026-10-06T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const line = (sec: number, lv: string, tag: string | null, msg: string) =>
  `[${iso(T0 + sec * 1000)}] [${lv}] ${tag ? `[${tag}] ` : ""}${msg}\n`;
const logPath = () => join(home, "ppm.log");

function params(over: Partial<LogQueryParams> = {}): LogQueryParams {
  return { ...DEFAULT_LOG_FILTER, levels: { error: true, warn: true, info: true, debug: true }, range: "all", from: 0, limit: 100, ...over };
}

const msgs = (entries: LogEntry[]) => entries.map((e) => e.msg);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-logs-store-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
  closeTraceDb();
  _resetLogStoreForTests();
});

afterAll(() => {
  closeTraceDb();
  _resetLogStoreForTests();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

describe("reading ppm.log", () => {
  it("makes one record per head line, with the lines under it attached", async () => {
    writeFileSync(logPath(), [
      line(0, "INFO", "supervisor", "Server started (PID 41)"),
      line(1, "ERROR", "chat", "turn failed: boom"),
      "    at run (chat.ts:10)\n",
      "    at main (index.ts:2)\n",
      line(2, "WARN", null, "no scope on this one"),
    ].join(""));
    const r = await queryLogs(params());
    expect(msgs(r.entries)).toEqual(["Server started (PID 41)", "turn failed: boom", "no scope on this one"]);
    expect(r.entries[1]!.more).toEqual(["    at run (chat.ts:10)", "    at main (index.ts:2)"]);
    expect(r.entries[1]!.src).toBe("ai");
    expect(r.entries[2]!.tag).toBe("ppm");
    expect(r.restarts).toEqual([T0]);
  });

  it("splits a process's own stderr off the record above it, at that record's time", async () => {
    writeFileSync(logPath(), [
      line(5, "INFO", "http", "GET /api/x 200 3ms"),
      "TypeError: undefined is not an object\n",
      "    at handler (route.ts:4)\n",
      "[Bun.serve]: request took too long\n",
    ].join(""));
    const r = await queryLogs(params());
    expect(r.entries.map((e) => [e.tag, e.lv, e.msg])).toEqual([
      ["http", "info", "GET /api/x 200 3ms"],
      ["stderr", "error", "TypeError: undefined is not an object"],
      ["stderr", "warn", "[Bun.serve]: request took too long"],
    ]);
    expect(r.entries[1]!.ts).toBe(T0 + 5000);
    expect(r.entries[1]!.more).toEqual(["    at handler (route.ts:4)"]);
  });

  it("keeps text before the first record instead of hiding it", async () => {
    writeFileSync(logPath(), ["left over from a crash\n", line(9, "INFO", "startup", "ready")].join(""));
    const r = await queryLogs(params());
    expect(msgs(r.entries)).toEqual(["left over from a crash", "ready"]);
    expect(r.entries[0]!.ts).toBe(T0 + 9000);
  });

  it("leaves a line still being written for the next read", async () => {
    writeFileSync(logPath(), `${line(0, "INFO", "http", "done")}[${iso(T0 + 1000)}] [INFO] [http] half`);
    expect(msgs((await queryLogs(params())).entries)).toEqual(["done"]);
    appendFileSync(logPath(), " a line\n");
    expect(msgs((await queryLogs(params())).entries)).toEqual(["done", "half a line"]);
  });
});

describe("filters, search and paging", () => {
  const sid = "2b9ca339-2661-42da-a84d-622566920078";
  beforeEach(() => {
    writeFileSync(logPath(), [
      line(0, "DEBUG", "sdk", "raw event"),
      line(1, "INFO", "chat", `session=${sid} turn started`),
      line(2, "WARN", "file-watcher", "watch limit near"),
      line(3, "ERROR", "chat", `session=${sid} turn failed: Rate Limited`),
      line(4, "FATAL", "supervisor", "server crashed"),
      line(5, "INFO", "tunnel", "quick tunnel up"),
    ].join(""));
  });

  it("filters by area, level, tag and chat, and counts the sidebar over the whole range", async () => {
    const ai = await queryLogs(params({ src: "ai" }));
    expect(msgs(ai.entries)).toEqual(["raw event", `session=${sid} turn started`, `session=${sid} turn failed: Rate Limited`]);
    expect(ai.inRange).toBe(3);
    expect(ai.stats.ai).toMatchObject({ total: 3, err: 1, warn: 0 });
    expect(ai.stats.server).toMatchObject({ total: 1, err: 1 });

    const errors = await queryLogs(params({ levels: { error: true, warn: false, info: false, debug: false } }));
    expect(msgs(errors.entries)).toEqual([`session=${sid} turn failed: Rate Limited`, "server crashed"]);

    const noSdk = await queryLogs(params({ src: "ai", tagsOff: ["ai:sdk"] }));
    expect(noSdk.entries.every((e) => e.tag === "chat")).toBe(true);

    const chat = await queryLogs(params({ chat: sid }));
    expect(chat.entries.map((e) => e.sid)).toEqual([sid, sid]);
    expect(chat.chats).toEqual([expect.objectContaining({ sid, count: 2 })]);
  });

  it("searches as plain text by default, case-insensitively, and as a regex on request", async () => {
    expect(msgs((await queryLogs(params({ q: "rate limited" }))).entries)).toEqual([`session=${sid} turn failed: Rate Limited`]);
    expect((await queryLogs(params({ q: "rate limited", caseSensitive: true }))).matched).toBe(0);
    expect((await queryLogs(params({ q: "turn (started|failed)", regex: true }))).matched).toBe(2);
    expect((await queryLogs(params({ q: "turn (started", regex: true }))).badRegex).toBe(true);
  });

  it("pages back from a record and says when there is more", async () => {
    const last2 = await queryLogs(params({ limit: 2 }));
    expect(msgs(last2.entries)).toEqual(["server crashed", "quick tunnel up"]);
    expect(last2.hasMore).toBe(true);
    const before = await queryLogs(params({ limit: 2, before: last2.entries[0]!.id }));
    expect(msgs(before.entries)).toEqual(["watch limit near", `session=${sid} turn failed: Rate Limited`]);
    const first = await queryLogs(params({ limit: 5, before: before.entries[0]!.id }));
    expect(msgs(first.entries)).toEqual(["raw event", `session=${sid} turn started`]);
    expect(first.hasMore).toBe(false);
  });

  it("reaches back to a record on request, with a few lines before it", async () => {
    writeFileSync(logPath(), Array.from({ length: 1200 }, (_, n) => line(n, "INFO", "http", `n${n}`)).join(""));
    const newest = await queryLogs(params({ limit: 100 }));
    const target = (await queryLogs(params({ limit: 2000 }))).entries.find((e) => e.msg === "n300")!;
    const r = await queryLogs(params({ limit: 100, before: newest.entries[0]!.id, reach: target.id }));
    expect(r.entries[0]!.msg).toBe(`n${300 - REACH_CONTEXT}`);
    expect(r.entries.at(-1)!.msg).toBe("n1099");
    expect(r.hasMore).toBe(true);
    expect(r.reachMissed).toBeUndefined();
  });

  it("says why it could not reach a record", async () => {
    writeFileSync(logPath(), Array.from({ length: MAX_REACH + 50 }, (_, n) => line(n, "INFO", "http", `n${n}`)).join(""));
    // The first record of a file is at byte 0, and the file is named by its first stamp.
    const oldestId = `p${T0.toString(36)}.0`;
    const far = await queryLogs(params({ limit: 10, reach: oldestId }));
    expect(far.reachMissed).toBe("far");
    expect(far.entries.length).toBe(MAX_REACH);
    expect(far.entries.at(-1)!.msg).toBe(`n${MAX_REACH + 49}`);
    const gone = await queryLogs(params({ limit: 10, reach: "pzzzz.0" }));
    expect(gone.reachMissed).toBe("gone");
    expect(gone.entries.length).toBe(10);
    expect((await queryLogs(params({ limit: 10 }))).reachMissed).toBeUndefined();
  });

  it("starts a time range at its own start, and `restart` at the last start", async () => {
    appendFileSync(logPath(), [line(10, "INFO", "supervisor", "Server started (PID 7)"), line(11, "INFO", "http", "after")].join(""));
    const recent = await queryLogs(params({ range: "15m", from: T0 + 4500 }));
    expect(msgs(recent.entries)).toEqual(["quick tunnel up", "Server started (PID 7)", "after"]);
    const sinceRestart = await queryLogs(params({ range: "restart" }));
    expect(sinceRestart.fromTs).toBe(T0 + 10_000);
    expect(msgs(sinceRestart.entries)).toEqual(["Server started (PID 7)", "after"]);
  });

  it("hands the issue grouping only warnings and worse, oldest first", async () => {
    expect(msgs(await readProblems(0))).toEqual(["watch limit near", `session=${sid} turn failed: Rate Limited`, "server crashed"]);
  });
});

describe("rotation", () => {
  it("keeps a record's id when ppm.log is copied to ppm.log.1 and emptied", async () => {
    writeFileSync(logPath(), [line(0, "INFO", "http", "one"), line(1, "ERROR", "chat", "two"), line(2, "INFO", "http", "three")].join(""));
    const before = await queryLogs(params());
    const twoId = before.entries[1]!.id;

    // What log-rotate does: .1 → .2, copy ppm.log → .1, truncate ppm.log in place.
    copyFileSync(logPath(), `${logPath()}.1`);
    truncateSync(logPath(), 0);
    appendFileSync(logPath(), line(3, "INFO", "http", "four"));

    const after = await queryLogs(params());
    expect(msgs(after.entries)).toEqual(["one", "two", "three", "four"]);
    expect(after.entries[1]!.id).toBe(twoId);
    const around = await readAround([twoId], 1, "all");
    expect(msgs(around.before)).toEqual(["one"]);
    expect(msgs(around.after)).toEqual(["three"]);
    expect(after.files.rotatedFiles).toBe(1);
  });

  it("notices a file that was emptied and has grown past its old length again", async () => {
    writeFileSync(logPath(), line(0, "INFO", "http", "old"));
    expect(msgs((await queryLogs(params())).entries)).toEqual(["old"]);
    // Emptied in place (same inode) and longer than before by the next read: only the content
    // says it is not the same file.
    truncateSync(logPath(), 0);
    appendFileSync(logPath(), [line(5, "WARN", "http", "brand new and much longer than before"), line(6, "INFO", "http", "next")].join(""));
    // Text is read back from disk, so check what only the index knows: level and time.
    expect((await queryLogs(params())).entries.map((e) => [e.lv, e.ts, e.msg])).toEqual([
      ["warn", T0 + 5000, "brand new and much longer than before"],
      ["info", T0 + 6000, "next"],
    ]);
  });

  it("lists each record once when a rotation copied ppm.log but could not empty it", async () => {
    // What log-rotate leaves when the truncate fails (EBUSY on Windows), tried again a minute
    // later: every rotated file is a copy of ppm.log's beginning, not an older log.
    writeFileSync(logPath(), [line(0, "INFO", "supervisor", "Server started (PID 1)"), line(1, "ERROR", "chat", "two")].join(""));
    await queryLogs(params());
    copyFileSync(logPath(), `${logPath()}.1`);
    appendFileSync(logPath(), line(2, "INFO", "http", "three"));
    renameSync(`${logPath()}.1`, `${logPath()}.2`);
    copyFileSync(logPath(), `${logPath()}.1`);
    appendFileSync(logPath(), line(3, "INFO", "http", "four"));

    const r = await queryLogs(params());
    expect(msgs(r.entries)).toEqual(["Server started (PID 1)", "two", "three", "four"]);
    expect(new Set(r.entries.map((e) => e.id)).size).toBe(4);
    expect(r.files.rotatedFiles).toBe(0);
    const around = await readAround([r.entries[1]!.id], 1, "all");
    expect(msgs(around.after)).toEqual(["three"]);
    expect(await restartTimes(0)).toEqual([T0]);
  });

  it("finds restarts in rotated files too", async () => {
    writeFileSync(`${logPath()}.1`, line(0, "INFO", "supervisor", "Server started (PID 1)"));
    writeFileSync(logPath(), line(60, "INFO", "supervisor", "Server started (PID 2)"));
    expect(await restartTimes(0)).toEqual([T0, T0 + 60_000]);
  });
});

describe("a line stamped out of step with the lines around it", () => {
  // A test running on a fake clock once wrote lines stamped six hours ahead into a real ppm.log.

  it("stays where it was written, and its file stays before the next one", async () => {
    writeFileSync(`${logPath()}.1`, [
      line(0, "INFO", "http", "a"),
      line(6 * 3600, "WARN", "http", "stamped hours ahead"),
      line(1, "INFO", "http", "b"),
    ].join(""));
    writeFileSync(logPath(), [line(60, "INFO", "http", "c"), line(61, "INFO", "http", "d")].join(""));
    expect(msgs((await queryLogs(params())).entries)).toEqual(["a", "stamped hours ahead", "b", "c", "d"]);
  });

  it("does not carry the lines after it past another log's lines", async () => {
    writeFileSync(logPath(), [
      line(0, "INFO", "http", "s0"),
      line(6 * 3600, "WARN", "http", "ahead 1"),
      line(6 * 3600, "WARN", "http", "ahead 2"),
      line(10, "INFO", "http", "s10"),
      line(30, "INFO", "http", "s30"),
      line(40, "INFO", "http", "s40"),
    ].join(""));
    writeFileSync(join(home, "cloudflared.log"), `${iso(T0 + 20_000)} INF t20\n`);
    expect(msgs((await queryLogs(params())).entries)).toEqual(["s0", "ahead 1", "ahead 2", "s10", "t20", "s30", "s40"]);
  });

  it("does not start a time range at it", async () => {
    writeFileSync(logPath(), [
      line(0, "INFO", "http", "old 1"),
      line(1, "INFO", "http", "old 2"),
      line(2, "INFO", "http", "old 3"),
      line(6 * 3600, "WARN", "http", "stamped hours ahead"),
      line(3, "INFO", "http", "old 4"),
      line(100, "INFO", "http", "new 1"),
      line(101, "INFO", "http", "new 2"),
    ].join(""));
    const r = await queryLogs(params({ range: "15m", from: T0 + 50_000 }));
    expect(msgs(r.entries)).toEqual(["new 1", "new 2"]);
  });

  it("is put back in step once the lines after it are written", async () => {
    writeFileSync(logPath(), [line(0, "INFO", "http", "s0"), line(6 * 3600, "WARN", "http", "ahead")].join(""));
    await queryLogs(params());
    appendFileSync(logPath(), [line(10, "INFO", "http", "s10"), line(20, "INFO", "http", "s20")].join(""));
    writeFileSync(join(home, "cloudflared.log"), `${iso(T0 + 15_000)} INF t15\n`);
    expect(msgs((await queryLogs(params())).entries)).toEqual(["s0", "ahead", "s10", "t15", "s20"]);
  });

  it("keeps its own stamp on screen", async () => {
    writeFileSync(logPath(), [line(0, "INFO", "http", "s0"), line(6 * 3600, "WARN", "http", "ahead"), line(10, "INFO", "http", "s10")].join(""));
    expect((await queryLogs(params())).entries.map((e) => e.ts)).toEqual([T0, T0 + 6 * 3600_000, T0 + 10_000]);
  });
});

describe("other sources", () => {
  it("reads cloudflared.log as the tunnel, with secrets taken out", async () => {
    writeFileSync(join(home, "cloudflared.log"), [
      `${iso(T0)} INF Registered tunnel connection connIndex=0\n`,
      `${iso(T0 + 1000)} ERR failed to serve token=eyJhIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwIn0\n`,
    ].join(""));
    const r = await queryLogs(params({ src: "tunnel" }));
    expect(r.entries.map((e) => [e.tag, e.lv])).toEqual([["cloudflared", "info"], ["cloudflared", "error"]]);
    expect(r.entries[1]!.msg).not.toContain("eyJhIjoiYWJj");
  });

  it("shows browser console lines tagged with the browser they came from", async () => {
    writeFileSync(logPath(), line(0, "INFO", "http", "server line"));
    recordTraceDevice("dev-1", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36");
    appendBatch([{
      traceId: "browser:dev-1", turnId: null, ts: T0 + 500, source: "browser", origin: "browser", providerId: null,
      refId: null, type: "console_error", payloadJson: JSON.stringify({ type: "console_error", args: ["[ws] closed", "1006"] }),
    }]);
    const r = await queryLogs(params());
    expect(r.entries.map((e) => [e.src, e.tag, e.lv, e.msg])).toEqual([
      ["server", "http", "info", "server line"],
      ["browser", "Chrome·Mac", "error", "[ws] closed 1006"],
    ]);
    expect(r.files.browserDevices).toBe(1);
  });
});

describe("indexing while the file grows", () => {
  it("indexes each record once when refreshes overlap", async () => {
    const block = (from: number, n: number) => {
      let s = "";
      for (let i = 0; i < n; i++) s += line((from + i) / 1000, "INFO", "http", `line ${from + i} ${"x".repeat(80)}`);
      return s;
    };
    writeFileSync(logPath(), block(0, 10));
    const ix = new LogFileIndex(logPath(), "ppm");
    const first = ix.refresh();
    const second = ix.refresh(); // these two wait for the first one's build…
    const third = ix.refresh();
    appendFileSync(logPath(), block(10, 30_000)); // …and find ~4 MB more, whose scan yields midway
    await Promise.all([first, second, third]);
    expect(ix.count).toBe(30_010);
  });
});

describe("browser lines past the cap", () => {
  it("keeps the newest browser lines when there are more than it reads", async () => {
    writeFileSync(logPath(), line(0, "INFO", "http", "server line"));
    recordTraceDevice("dev-1", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0");
    const n = 50_001; // one more than a range reads
    appendBatch(Array.from({ length: n }, (_, i) => ({
      traceId: "browser:dev-1", turnId: null, ts: T0 + 1000 + i, source: "browser", origin: "browser", providerId: null,
      refId: null, type: "console_log", payloadJson: JSON.stringify({ type: "console_log", args: [`browser line ${i}`] }),
    })));
    const r = await queryLogs(params({ src: "browser", limit: 2 }));
    expect(msgs(r.entries)).toEqual([`browser line ${n - 2}`, `browser line ${n - 1}`]);
  });
});

describe("live tail", () => {
  it("starts at the current end and then hands out only what was added", async () => {
    writeFileSync(logPath(), line(0, "INFO", "http", "already there"));
    const first = await readNewEntries(null, lastTraceRowid);
    expect(first.entries).toEqual([]);
    appendFileSync(logPath(), [line(1, "WARN", "chat", "new one"), line(2, "INFO", "http", "new two")].join(""));
    const second = await readNewEntries(first.cursor, lastTraceRowid);
    expect(msgs(second.entries)).toEqual(["new one", "new two"]);
    const third = await readNewEntries(second.cursor, lastTraceRowid);
    expect(third.entries).toEqual([]);
  });

  it("starts over on a rotated ppm.log rather than skipping its first lines", async () => {
    writeFileSync(logPath(), [line(0, "INFO", "http", "a"), line(1, "INFO", "http", "b")].join(""));
    const first = await readNewEntries(null, lastTraceRowid);
    copyFileSync(logPath(), `${logPath()}.1`);
    truncateSync(logPath(), 0);
    appendFileSync(logPath(), line(2, "INFO", "http", "after rotation"));
    expect(msgs((await readNewEntries(first.cursor, lastTraceRowid)).entries)).toEqual(["after rotation"]);
  });
});
