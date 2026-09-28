/**
 * The trace database's own guarantees: the pragmas that make it a cheap log with a working
 * size cap, and `seq` staying a gapless 1..n per trace even when two processes append to the
 * same trace at once — the server and `ppm chat send` do exactly that.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb, getTraceDb, getTraceDbPath } from "../../../src/services/session-trace/session-trace-db.ts";
import {
  appendBatch,
  readEvents,
  readSessionTimeline,
  recordTraceAlias,
  resolveTraceId,
  type TraceRow,
} from "../../../src/services/session-trace/session-trace-store.ts";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-trace-db-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
});

afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

function row(traceId: string, type = "text", extra: Partial<TraceRow> = {}): TraceRow {
  return {
    traceId, turnId: null, ts: Date.now(), source: "agent", origin: "unknown",
    providerId: null, refId: null, type, payloadJson: JSON.stringify({ type }), ...extra,
  };
}

describe("session-trace.db", () => {
  it("lives under the PPM dir, with incremental vacuum, WAL and synchronous=NORMAL", () => {
    const db = getTraceDb();
    expect(getTraceDbPath()).toBe(join(process.env.PPM_HOME!, "session-trace.db"));
    expect((db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
    expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
  });

  it("a second open is a no-op, and reopening keeps what was written", () => {
    const first = getTraceDb();
    expect(getTraceDb()).toBe(first);
    appendBatch([row("t1")]);
    closeTraceDb();
    const reopened = getTraceDb();
    expect(reopened).not.toBe(first);
    expect(readEvents("t1").map((e) => e.seq)).toEqual([1]);
    // synchronous is per connection, so it has to be set again on every open.
    expect((reopened.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
  });

  it("waits out a lock another process holds while it opens, instead of failing", async () => {
    getTraceDb();
    closeTraceDb();
    const holder = new Database(getTraceDbPath());
    holder.exec("BEGIN EXCLUSIVE");
    const dbPath = resolve(import.meta.dir, "../../../src/services/session-trace/session-trace-db.ts");
    const child = Bun.spawn(["bun", "-e", `
      const { getTraceDb } = await import(${JSON.stringify(dbPath)});
      getTraceDb();`], { env: { ...process.env, PPM_HOME: process.env.PPM_HOME! }, stderr: "pipe" });
    // Well inside busy_timeout. The open's own pragmas take locks, so the timeout has to be
    // set before them — set after, the full suite's server-plus-CLI race failed here.
    setTimeout(() => holder.exec("COMMIT"), 300);
    const code = await child.exited;
    holder.close();
    expect(await new Response(child.stderr).text()).toBe("");
    expect(code).toBe(0);
  });
});

describe("appendBatch", () => {
  it("numbers interleaved appends 1..n per trace, with no gap and no duplicate", () => {
    appendBatch([row("a"), row("b"), row("a")]);
    appendBatch([row("b"), row("a")]);
    appendBatch([row("b")]);
    expect(readEvents("a").map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(readEvents("b").map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("round-trips every column", () => {
    appendBatch([row("x", "tool_use", {
      turnId: "turn-1", ts: 1234, source: "server", origin: "cli", providerId: "claude", refId: "ref",
      payloadJson: JSON.stringify({ type: "tool_use", tool: "Read" }),
    })]);
    expect(readEvents("x")).toEqual([{
      traceId: "x", seq: 1, turnId: "turn-1", ts: 1234, source: "server", origin: "cli",
      providerId: "claude", refId: "ref", type: "tool_use", payload: { type: "tool_use", tool: "Read" },
    }]);
  });

  it("keeps seq gapless when two processes append to one trace at the same time", async () => {
    getTraceDb(); // create the file and schema before the writers race for it
    const storePath = resolve(import.meta.dir, "../../../src/services/session-trace/session-trace-store.ts");
    const script = `
      const { appendBatch } = await import(${JSON.stringify(storePath)});
      for (let i = 0; i < 20; i++) {
        appendBatch(Array.from({ length: 10 }, () => ({
          traceId: "shared", turnId: null, ts: Date.now(), source: "agent", origin: "cli",
          providerId: null, refId: null, type: "text", payloadJson: "{}",
        })));
        await Bun.sleep(1);
      }`;
    const env = { ...process.env, PPM_HOME: process.env.PPM_HOME! };
    const procs = [0, 1].map(() => Bun.spawn(["bun", "-e", script], { env, stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    for (const p of procs) {
      const errText = await new Response(p.stderr).text();
      if (errText.trim()) console.error(errText);
    }
    expect(codes).toEqual([0, 0]);
    const seqs = readEvents("shared").map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
  });
});

describe("aliases", () => {
  it("maps an id a provider migrated to back to the trace the run started under", () => {
    appendBatch([row("ppm-id")]);
    recordTraceAlias("thread-id", "ppm-id");
    expect(resolveTraceId("thread-id")).toBe("ppm-id");
    expect(resolveTraceId("ppm-id")).toBe("ppm-id");
    // A second migration stores the root, never a chain.
    recordTraceAlias("third-id", "thread-id");
    expect(resolveTraceId("third-id")).toBe("ppm-id");
  });

  it("puts browser rows filed under any of the session's ids into its timeline", () => {
    appendBatch([row("ppm-id", "user_message", { ts: 100 })]);
    recordTraceAlias("thread-id", "ppm-id");
    appendBatch([
      row("browser:dev-1", "browser_error", { ts: 150, source: "browser", origin: "browser", refId: "thread-id" }),
      row("ppm-id", "done", { ts: 200 }),
      row("browser:dev-1", "console_error", { ts: 250, source: "browser", origin: "browser", refId: "someone-else" }),
    ]);
    expect(readSessionTimeline("thread-id").map((e) => e.type)).toEqual(["user_message", "browser_error", "done"]);
  });
});
