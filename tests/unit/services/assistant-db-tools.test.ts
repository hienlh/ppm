/**
 * The Assistant's database tools on a real SQLite file: a connection the user took away from
 * the AI is neither listed nor opened, nothing about how to reach a connection is returned, a
 * query runs only when proven to read and then on the read-only path even on a writable
 * connection, results are capped, and every statement is audited as the agent's.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConnectionById, insertConnection, openTestDb, setDb, updateConnection } from "../../../src/services/db.service.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../../src/services/database/adapter-registry.ts";
import { getAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";
import { runConnectionQuery, READ_ONLY_RUN_MESSAGE } from "../../../src/services/database/run-connection-query.ts";
import { dbListConnections, dbQuery, MAX_CELL_CHARS, MAX_QUERY_ROWS } from "../../../src/services/assistant-mcp/assistant-db-tools.ts";

const CALLER = { actor: "agent" as const, callerIp: null, callerUa: "PPM Assistant (session test)" };
const dirs: string[] = [];
let path = "";
let open = 0;
let hidden = 0;
const spies: Array<{ mockRestore(): void }> = [];

const text = (result: Record<string, unknown>) => (result.content as Array<{ text: string }>)[0]!.text;
const count = () => {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n; } finally { db.close(); }
};

beforeEach(() => {
  initAdapters();
  setDb(openTestDb());
  getAuditDb().exec("DELETE FROM query_log");
  const dir = mkdtempSync(join(tmpdir(), "ppm-asst-db-"));
  dirs.push(dir);
  path = join(dir, "data.db");
  const db = new Database(path);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO items (id, name) VALUES (?, ?)");
  for (let i = 1; i <= 250; i++) insert.run(i, i === 1 ? "x".repeat(2_000) : `item ${i}`);
  insert.finalize();
  db.close();
  open = insertConnection("sqlite", "open", { type: "sqlite", path }).id;
  updateConnection(open, { readonly: 0 });
  hidden = insertConnection("sqlite", "private", { type: "sqlite", path }).id;
  updateConnection(hidden, { aiAccess: 0 });
});
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
afterAll(() => {
  for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handle */ } }
});

describe("db_list_connections", () => {
  it("lists only connections available to the AI, without how to reach them", () => {
    const answer = text(dbListConnections());
    const parsed = JSON.parse(answer);
    expect(parsed.connections).toEqual([{ id: open, name: "open", type: "sqlite", readonly: false }]);
    expect(parsed.note).toContain("1 more saved connection is not available");
    expect(answer).not.toContain(path.replaceAll("\\", "\\\\"));
    expect(answer).not.toContain("data.db");
  });
});

describe("db_query", () => {
  it("refuses a connection the user took away from the AI, by id or by name", async () => {
    const runQuery = spyOn(getAdapter("sqlite"), "runQuery");
    spies.push(runQuery);
    for (const ref of [hidden, "private", String(hidden)]) {
      const result = await dbQuery({ connectionId: ref, sql: "SELECT 1" }, CALLER);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("not available to the AI");
    }
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("runs a proven read on the read-only path even on a writable connection, and audits it as the agent's", async () => {
    const runQuery = spyOn(getAdapter("sqlite"), "runQuery");
    spies.push(runQuery);
    const result = await dbQuery({ connectionId: open, sql: "SELECT count(*) AS n, lower('ABC') AS l FROM items" }, CALLER);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toMatchObject({ connection: "open", columns: ["n", "l"], rows: [[250, "abc"]], rowCount: 1 });
    expect((runQuery.mock.calls[0]![0] as { readonly?: boolean }).readonly).toBe(true);
    expect(listQueryLogs({ connectionId: open })[0]).toMatchObject({ actor: "agent", status: "ok", source: "editor", caller_ua: CALLER.callerUa });
  });

  it("does not run a query it cannot prove reads, and records that it refused", async () => {
    for (const sql of ["UPDATE items SET name = 'y'", "PRAGMA user_version = 5", "SELECT load_extension('x')"]) {
      const result = await dbQuery({ connectionId: open, sql }, CALLER);
      expect(result.isError).toBe(true);
      expect(text(result)).toStartWith("Not run: this query may change data");
    }
    expect(count()).toBe(250);
    const db = new Database(path, { readonly: true });
    try { expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0); } finally { db.close(); }
    expect(listQueryLogs({ connectionId: open }).map((l) => l.status)).toEqual(["blocked", "blocked", "blocked"]);
  });

  it("caps rows and cuts long values, and says so", async () => {
    const result = await dbQuery({ connectionId: "open", sql: "SELECT id, name FROM items ORDER BY id" }, CALLER);
    const parsed = JSON.parse(text(result));
    expect(parsed.rows).toHaveLength(MAX_QUERY_ROWS);
    expect(parsed.truncated).toContain(`first ${MAX_QUERY_ROWS} rows`);
    expect(parsed.rows[0][1].length).toBeLessThan(2_000);
    expect(parsed.rows[0][1]).toStartWith("x".repeat(MAX_CELL_CHARS));
    expect(parsed.rows[0][1]).toContain("more characters cut");
  });

  it("says when the query fails, and when the connection does not exist", async () => {
    const failed = await dbQuery({ connectionId: open, sql: "SELECT * FROM nowhere" }, CALLER);
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("The query failed on \"open\"");
    const missing = await dbQuery({ connectionId: 99_999, sql: "SELECT 1" }, CALLER);
    expect(text(missing)).toContain("No saved connection");
  });
});

describe("runConnectionQuery with forceReadonly", () => {
  it("refuses a write before it reaches a writable connection", async () => {
    const conn = getConnectionById(open)!;
    expect(conn.readonly).toBe(0);
    const outcome = await runConnectionQuery({ conn, sql: "DELETE FROM items", caller: CALLER, forceReadonly: true });
    expect(outcome).toEqual({ ok: false, status: 403, message: READ_ONLY_RUN_MESSAGE });
    expect(count()).toBe(250);
  });
});
