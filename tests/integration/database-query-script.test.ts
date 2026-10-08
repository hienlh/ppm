/**
 * The Query tab's run over HTTP: `POST /connections/:id/query/script` streaming one JSON event per
 * line, its answers before anything runs, Stop through `/query/cancel`, the connection's query
 * timeout, the browser going away mid-run, and the one audit entry each run leaves. SQLite always
 * runs; the Postgres part only when a server is given, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres bun test tests/integration/database-query-script.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { closeAuditDb, getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { insertQueryLog, listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import { ROLLED_BACK_OPEN_TRANSACTION } from "../../src/services/database/query-script-runner.ts";
import {
  QUERY_HISTORY_PAGE, QUERY_SCRIPT_CONTENT_TYPE, type QueryHistoryResponse, type QueryScriptEvent, type QueryStatementResult,
} from "../../src/shared/db-query-script.ts";

const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;
const app = () => new Hono().route("/db", databaseRoutes);
let runs = 0;
const runId = () => `run-${++runs}`;

function script(id: number | string, body: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  return app().request(`/db/connections/${id}/query/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify({ runId: runId(), ...body }),
    ...init,
  });
}

/** Every event of a streamed run, `onEvent` hearing each as it arrives. */
async function readEvents(res: Response, onEvent?: (e: QueryScriptEvent) => void): Promise<QueryScriptEvent[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(QUERY_SCRIPT_CONTENT_TYPE);
  const events: QueryScriptEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const event = JSON.parse(buffered.slice(0, newline)) as QueryScriptEvent;
      buffered = buffered.slice(newline + 1);
      events.push(event);
      onEvent?.(event);
    }
  }
  expect(buffered).toBe("");
  return events;
}

const resultsOf = (events: QueryScriptEvent[]): QueryStatementResult[] => events.flatMap((e) => (e.type === "statement" ? [e.result] : []));

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-query-script-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
  initAdapters();
});

afterAll(async () => {
  closeAuditDb();
  await postgresService.closeAll();
  await readonlyPostgresService.closeAll();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("query script on SQLite", () => {
  let path = "";
  let rw = 0;
  let ro = 0;
  const count = () => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    setDb(openTestDb());
    getAuditDb().exec("DELETE FROM query_log");
    const dir = mkdtempSync(join(tmpdir(), "ppm-query-script-"));
    tempDirs.push(dir);
    path = join(dir, "target.db");
    const db = new Database(path);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    db.close();
    rw = insertConnection("sqlite", "rw", { type: "sqlite", path }).id;
    updateConnection(rw, { readonly: 0 });
    ro = insertConnection("sqlite", "ro", { type: "sqlite", path }).id;
  });

  it("streams what each statement did, and leaves one audit entry for the run", async () => {
    const sql = "SELECT id FROM items ORDER BY id;\nUPDATE items SET name = 'x' WHERE id < 3;\nSELECT name FROM items WHERE id = 1";
    const events = await readEvents(await script(rw, { sql }));
    expect(events.map((e) => e.type)).toEqual(["start", "running", "statement", "running", "statement", "running", "statement", "done"]);
    expect(events[0]).toEqual({ type: "start", statements: [{ startLine: 1, endLine: 1 }, { startLine: 2, endLine: 2 }, { startLine: 3, endLine: 3 }] });
    const [first, second, third] = resultsOf(events);
    expect(first!.resultSets[0]!.rows).toEqual([[1], [2], [3]]);
    expect(second).toMatchObject({ resultSets: [], rowsAffected: 2 });
    expect(third!.resultSets[0]!.rows).toEqual([["x"]]);
    const [entry, ...others] = listQueryLogs({ connectionId: rw });
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ source: "editor", actor: "human", operation: "script", sql, status: "ok", error: null, row_count: 6 });
  });

  it("names a run of one statement by what it does", async () => {
    await readEvents(await script(rw, { sql: "-- one\nUPDATE items SET name = 'y'" }));
    expect(listQueryLogs({ connectionId: rw })[0]).toMatchObject({ operation: "update", status: "ok", row_count: 3 });
  });

  it("stops at the statement that fails unless asked to go on, and says which line it is", async () => {
    const sql = "UPDATE items SET name = 'z' WHERE id = 1;\nSELECT nosuch\n  FROM items;\nDELETE FROM items";
    const stopped = resultsOf(await readEvents(await script(rw, { sql })));
    expect(stopped.map((r) => r.index)).toEqual([0, 1]);
    expect(stopped[1]).toMatchObject({ error: "no such column: nosuch", errorLine: 2 });
    expect(count()).toBe(3);
    expect(listQueryLogs({ connectionId: rw })[0]).toMatchObject({ status: "error", error: "no such column: nosuch" });
    const onward = resultsOf(await readEvents(await script(rw, { sql, continueOnError: true })));
    expect(onward.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(count()).toBe(0);
  });

  it("keeps the row limit the run asked for, brought within the allowed ones", async () => {
    const cut = resultsOf(await readEvents(await script(rw, { sql: "SELECT id FROM items", maxRows: 2 })));
    expect(cut[0]!.resultSets[0]).toMatchObject({ rows: [[1], [2]], truncated: true });
    const least = resultsOf(await readEvents(await script(rw, { sql: "SELECT id FROM items", maxRows: 0 })));
    expect(least[0]!.resultSets[0]!.rows).toEqual([[1]]);
    const fallback = resultsOf(await readEvents(await script(rw, { sql: "SELECT id FROM items", maxRows: "lots" })));
    expect(fallback[0]!.resultSets[0]!.truncated).toBeUndefined();
  });

  it("rolls back a transaction the script left open, and says so in the stream and the log", async () => {
    const events = await readEvents(await script(rw, { sql: "BEGIN; DELETE FROM items" }));
    expect(events.at(-2)).toEqual({ type: "message", level: "error", text: ROLLED_BACK_OPEN_TRANSACTION });
    expect(count()).toBe(3);
    expect(listQueryLogs({ connectionId: rw })[0]).toMatchObject({ status: "error", error: ROLLED_BACK_OPEN_TRANSACTION });
  });

  it("refuses a script that writes on a readonly connection before running any of it", async () => {
    const res = await script(ro, { sql: "SELECT 1; DELETE FROM items" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("readonly");
    expect(count()).toBe(3);
    expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "blocked", operation: "script" });
    const read = resultsOf(await readEvents(await script(ro, { sql: "SELECT COUNT(*) FROM items" })));
    expect(read[0]!.resultSets[0]!.rows).toEqual([[3]]);
  });

  it("runs a refused script once with write access for PPM's password, and the connection stays readonly", async () => {
    const auth = configService.get("auth");
    configService.set("auth", { ...auth, enabled: true, token: "ppm-pass" });
    try {
      const sql = "DELETE FROM items WHERE id = 1";
      const wrong = await script(ro, { sql, writeOnce: { password: "nope" } });
      expect(wrong.status).toBe(403);
      expect(((await wrong.json()) as { error: string }).error).toBe("Wrong password");
      expect(count()).toBe(3);
      expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "blocked", error: "Wrong password", params_json: JSON.stringify({ writeOnce: true }) });

      const [deleted] = resultsOf(await readEvents(await script(ro, { sql, writeOnce: { password: "ppm-pass" } })));
      expect(deleted).toMatchObject({ rowsAffected: 1 });
      expect(count()).toBe(2);
      expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "ok", params_json: JSON.stringify({ writeOnce: true }) });

      expect((await script(ro, { sql: "DELETE FROM items" })).status).toBe(403);
      expect(count()).toBe(2);
      // A writable connection needs no lift: the flag is ignored rather than recorded.
      await readEvents(await script(rw, { sql: "SELECT 1", writeOnce: { password: "anything" } }));
      expect(listQueryLogs({ connectionId: rw })[0]!.params_json).toBeNull();
    } finally {
      configService.set("auth", auth);
    }
  });

  it("explains a statement rather than running it", async () => {
    const [plan] = resultsOf(await readEvents(await script(rw, { sql: "DELETE FROM items WHERE id = 1", explain: true })));
    expect(plan!.resultSets[0]!.columns.map((c) => c.name)).toContain("detail");
    expect(count()).toBe(3);
    expect(listQueryLogs({ connectionId: rw })[0]!.params_json).toBe(JSON.stringify({ explain: true }));
  });

  it("answers what is wrong with a request before anything runs", async () => {
    const status = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];
    expect(await status(await script(rw, { sql: "" }))).toEqual([400, "sql is required"]);
    expect(await status(await script(rw, { sql: "-- nothing\n;" }))).toEqual([400, "The script has no statements to run"]);
    expect(await status(await script(rw, { sql: "SELECT 1", runId: "not a/run" }))).toEqual([400, "runId is required: letters, digits, - and _"]);
    expect(await status(await script(99_999, { sql: "SELECT 1" }))).toEqual([404, "Connection not found"]);
    expect(listQueryLogs({ connectionId: rw })).toEqual([]);
  });

  it("lists what was run here from a Query tab or by an agent, newest first, with how long the log keeps it", async () => {
    await readEvents(await script(rw, { sql: "SELECT 1 AS first" }));
    await readEvents(await script(rw, { sql: "SELECT nosuch" }));
    // An agent calls without the web client's header.
    await readEvents(await app().request(`/db/connections/${rw}/query/script`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: runId(), sql: "SELECT 3 AS agent" }),
    }));
    // A grid filter is not something the user ran.
    await app().request(`/db/connections/${rw}/query`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: "SELECT 4", source: "filter" }),
    });
    await readEvents(await script(ro, { sql: "SELECT 5 AS elsewhere" }));
    const history = async (id: number | string, query = "") => {
      const res = await app().request(`/db/connections/${id}/history${query}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: QueryHistoryResponse }).data;
    };
    const all = await history(rw);
    expect(all.items.map((i) => i.sql)).toEqual(["SELECT 3 AS agent", "SELECT nosuch", "SELECT 1 AS first"]);
    expect(all.items[0]).toMatchObject({ status: "ok", byAgent: true, rowCount: 1, error: null });
    expect(all.items[1]).toMatchObject({ status: "error", byAgent: false, error: "no such column: nosuch" });
    expect(all.items[2]!.ranAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Math.abs(Date.now() - Date.parse(all.items[2]!.ranAt))).toBeLessThan(60_000);
    expect(all).toMatchObject({ retentionDays: 30, maxSizeMb: 500 });
    expect((await history(rw, "?search=NOSUCH")).items.map((i) => i.sql)).toEqual(["SELECT nosuch"]);
    expect((await history(rw, "?offset=2")).items.map((i) => i.sql)).toEqual(["SELECT 1 AS first"]);
    expect((await history(ro)).items.map((i) => i.sql)).toEqual(["SELECT 5 AS elsewhere"]);
    expect((await app().request("/db/connections/99999/history")).status).toBe(404);
  });

  it("keeps a database file's runs under its path", async () => {
    const file = `/db/connections/file/query/script?path=${encodeURIComponent(path)}`;
    const res = await app().request(file, {
      method: "POST", headers: { "Content-Type": "application/json", "x-ppm-client": "web" }, body: JSON.stringify({ runId: runId(), sql: "SELECT 6 AS from_file" }),
    });
    expect(resultsOf(await readEvents(res))[0]!.resultSets[0]!.rows).toEqual([[6]]);
    // Neither a saved connection to the same file nor one that happens to be named by its path is the file.
    await readEvents(await script(rw, { sql: "SELECT 7 AS saved" }));
    const namesake = insertConnection("sqlite", path, { type: "sqlite", path }).id;
    await readEvents(await script(namesake, { sql: "SELECT 8 AS namesake" }));
    const history = await app().request(`/db/connections/file/history?path=${encodeURIComponent(path)}`);
    const { data } = (await history.json()) as { data: QueryHistoryResponse };
    expect(data.items.map((i) => i.sql)).toEqual(["SELECT 6 AS from_file"]);
    expect(listQueryLogs({ connectionId: rw }).map((r) => r.sql)).toEqual(["SELECT 7 AS saved"]);
  });

  it("lists what the AI chat's database tools ran beside the Query tab's runs", async () => {
    insertQueryLog({ connectionId: rw, connectionName: "rw", dbType: "sqlite", source: "ai", actor: "agent", operation: "select", sql: "SELECT 9 AS by_ai", status: "ok" });
    await readEvents(await script(rw, { sql: "SELECT 10 AS by_hand" }));
    const res = await app().request(`/db/connections/${rw}/history`);
    const { data } = (await res.json()) as { data: QueryHistoryResponse };
    expect(data.items.map((i) => [i.sql, i.byAgent])).toEqual([["SELECT 10 AS by_hand", false], ["SELECT 9 AS by_ai", true]]);
  });

  it("hands the history over a page at a time", async () => {
    for (let i = 0; i <= QUERY_HISTORY_PAGE; i++) {
      insertQueryLog({ connectionId: rw, connectionName: "rw", dbType: "sqlite", source: "editor", actor: "human", operation: "select", sql: `SELECT ${i}`, status: "ok" });
    }
    const page = async (query: string) => {
      const res = await app().request(`/db/connections/${rw}/history${query}`);
      return ((await res.json()) as { data: QueryHistoryResponse }).data.items.map((i) => i.sql);
    };
    const first = await page("");
    expect(first).toHaveLength(QUERY_HISTORY_PAGE);
    expect(first[0]).toBe(`SELECT ${QUERY_HISTORY_PAGE}`);
    expect(await page(`?offset=${QUERY_HISTORY_PAGE}`)).toEqual(["SELECT 0"]);
  });

  it("answers a Stop for a run that has ended without an error", async () => {
    const res = await app().request(`/db/connections/${rw}/query/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: "gone" }),
    });
    expect(await res.json()).toEqual({ ok: true, data: { stopped: false } });
  });
});

const PG_URL = process.env.PPM_TEST_PG_URL;

describe.skipIf(!PG_URL)("query script on Postgres", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  let rw = 0;
  /** Sessions of this test still running a pg_sleep. */
  const sleepers = async (tag: string) => Number((await admin!`
    SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE ${`%${tag}%`} AND state = 'active'`)[0]!.n);

  beforeEach(() => {
    setDb(openTestDb());
    getAuditDb().exec("DELETE FROM query_log");
    rw = insertConnection("postgres", "rw", { type: "postgres", connectionString: PG_URL! }).id;
    updateConnection(rw, { readonly: 0 });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("stops the statement running on /query/cancel and runs none after it", async () => {
    const id = "stop-me";
    const start = performance.now();
    const res = await script(rw, { runId: id, sql: "SELECT 1;\nSELECT pg_sleep(30) /* stop-me */;\nSELECT 3", continueOnError: true });
    let duplicate: Response | null = null;
    const events = await readEvents(res, (event) => {
      if (event.type !== "running" || event.index !== 1) return;
      void (async () => {
        await new Promise((r) => setTimeout(r, 200));
        duplicate = await script(rw, { runId: id, sql: "SELECT 1" });
        await app().request(`/db/connections/${rw}/query/cancel`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: id }),
        });
      })();
    });
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(duplicate!.status).toBe(409);
    const results = resultsOf(events);
    expect(results.map((r) => [r.index, r.stopped])).toEqual([[0, undefined], [1, "user"]]);
    expect(results[1]!.error).toContain("canceling statement");
    expect(await sleepers("stop-me")).toBe(0);
    expect(listQueryLogs({ connectionId: rw })[0]).toMatchObject({ status: "error" });
  });

  it("stops a statement that outruns the connection's query timeout", async () => {
    const timed = insertConnection("postgres", "timed", { type: "postgres", connectionString: PG_URL!, queryTimeoutSec: 1 }).id;
    updateConnection(timed, { readonly: 0 });
    const start = performance.now();
    const results = resultsOf(await readEvents(await script(timed, { sql: "SELECT pg_sleep(10) /* timed-out */" })));
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(results[0]).toMatchObject({ stopped: "timeout" });
    expect(results[0]!.error).toStartWith("Stopped after the connection's query timeout (1 s)");
    expect(await sleepers("timed-out")).toBe(0);
  });

  it("stops the run when the browser goes away", async () => {
    const abort = new AbortController();
    const res = await script(rw, { sql: "SELECT pg_sleep(30) /* walked-away */" }, { signal: abort.signal });
    const reader = res.body!.getReader();
    await reader.read();
    expect(await sleepers("walked-away")).toBe(1);
    abort.abort();
    await reader.cancel().catch(() => {});
    const until = Date.now() + 3_000;
    while (Date.now() < until && (await sleepers("walked-away")) > 0) await new Promise((r) => setTimeout(r, 50));
    expect(await sleepers("walked-away")).toBe(0);
  });

  // A client leaving a real socket fires both the request's signal and the stream's cancel, at
  // once (Bun 1.3.11); either one alone has to stop the run.
  it("stops the run when its stream is cancelled, with the request's signal never firing", async () => {
    const res = await script(rw, { sql: "SELECT pg_sleep(30) /* stream-cancelled */" });
    const reader = res.body!.getReader();
    await reader.read();
    expect(await sleepers("stream-cancelled")).toBe(1);
    await reader.cancel();
    const until = Date.now() + 3_000;
    while (Date.now() < until && (await sleepers("stream-cancelled")) > 0) await new Promise((r) => setTimeout(r, 50));
    expect(await sleepers("stream-cancelled")).toBe(0);
  });
});
