/**
 * The Query tab's session on a real SQLite file: a handle of its own for the run, each statement
 * prepared alone, results cut at the run's limit, and a transaction the script left open found and
 * rolled back.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../../../../src/services/database/adapter-registry.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { isReadonlyRefusal, QueryStatementError, ReadonlyViolationError } from "../../../../src/services/database/db-errors.ts";
import type { DbConnectionConfig, DbQuerySession } from "../../../../src/types/database.ts";

initAdapters();
const dirs: string[] = [];
const sessions: DbQuerySession[] = [];

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-query-session-"));
  dirs.push(dir);
  const path = join(dir, "data.db");
  const db = new Database(path);
  db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
  db.exec("INSERT INTO parent (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e')");
  db.exec("INSERT INTO child VALUES (1, 1)");
  db.close();
  return path;
}

async function open(path: string, opts: Partial<DbConnectionConfig> = {}): Promise<DbQuerySession> {
  const session = await getAdapter("sqlite").openQuerySession({ type: "sqlite", path, ...opts });
  sessions.push(session);
  return session;
}

function count(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

async function failure(p: Promise<unknown>): Promise<QueryStatementError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QueryStatementError);
    return e as QueryStatementError;
  }
  throw new Error("expected the statement to fail");
}

afterAll(async () => {
  for (const s of sessions) await s.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite query session", () => {
  it("keeps the run's limit of rows and says it cut the rest", async () => {
    const session = await open(seed());
    const cut = await session.run("SELECT id FROM parent ORDER BY id", 3);
    expect(cut.resultSets).toEqual([{ columns: [{ name: "id", type: "INTEGER" }], rows: [[1], [2], [3]], truncated: true }]);
    const whole = await session.run("SELECT id FROM parent ORDER BY id", 5);
    expect(whole.resultSets[0]!.rows).toHaveLength(5);
    expect(whole.resultSets[0]!.truncated).toBe(false);
  });

  it("describes the columns of a query that finds nothing, and keeps two of one name apart", async () => {
    const session = await open(seed());
    const none = await session.run("SELECT id, name FROM parent WHERE 0", 100);
    expect(none.resultSets).toEqual([{ columns: [{ name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" }], rows: [], truncated: false }]);
    const twice = await session.run("SELECT 1 AS a, 2 AS b, 3 AS a", 100);
    expect(twice.resultSets[0]!.columns.map((c) => c.name)).toEqual(["a", "b", "a"]);
    expect(twice.resultSets[0]!.rows).toEqual([[1, 2, 3]]);
  });

  it("counts the rows a write changed, and never reports a stale count for DDL", async () => {
    const session = await open(seed());
    expect(await session.run("UPDATE parent SET name = name || '!' WHERE id <= 2", 100)).toEqual({ resultSets: [], rowsAffected: 2, notices: [] });
    expect(await session.run("UPDATE parent SET name = 'x' WHERE id = 99", 100)).toMatchObject({ rowsAffected: 0 });
    const ddl = await session.run("CREATE TABLE other (a)", 100);
    expect(ddl.rowsAffected).toBeUndefined();
    expect(await session.run("WITH gone AS (SELECT 5 AS id) DELETE FROM parent WHERE id IN (SELECT id FROM gone)", 100)).toMatchObject({ rowsAffected: 1 });
  });

  it("holds a temporary table from one statement to the next, and drops it with the session", async () => {
    const path = seed();
    const session = await open(path);
    await session.run("CREATE TEMP TABLE scratch (a)", 100);
    await session.run("INSERT INTO scratch VALUES (7)", 100);
    expect((await session.run("SELECT a FROM scratch", 100)).resultSets[0]!.rows).toEqual([[7]]);
    await session.close();
    const next = await open(path);
    expect((await failure(next.run("SELECT a FROM scratch", 100))).message).toContain("no such table");
  });

  it("finds a transaction the script left open and rolls it back; none, and it says so", async () => {
    const path = seed();
    const session = await open(path);
    expect(await session.rollbackOpenTransaction()).toBe(false);
    await session.run("BEGIN", 100);
    await session.run("DELETE FROM child", 100);
    expect(count(path, "child")).toBe(1);
    expect(await session.rollbackOpenTransaction()).toBe(true);
    expect(await session.rollbackOpenTransaction()).toBe(false);
    await session.close();
    expect(count(path, "child")).toBe(1);
  });

  it("runs the first statement of text that holds two, never the second", async () => {
    const path = seed();
    const session = await open(path);
    await session.run("INSERT INTO parent (id) VALUES (9); DELETE FROM parent", 100);
    expect(count(path, "parent")).toBe(6);
  });

  it("enforces foreign keys, as the grid's handle does", async () => {
    const session = await open(seed());
    expect((await failure(session.run("DELETE FROM parent WHERE id = 1", 100))).message).toContain("FOREIGN KEY");
  });

  it("says which character an error points at, counted in characters rather than bytes", async () => {
    const session = await open(seed());
    const sql = "SELECT 'ẞẞẞ',\n  nosuch FROM parent";
    const error = await failure(session.run(sql, 100));
    expect(error.message).toContain("no such column: nosuch");
    expect(error.where).toEqual({ position: sql.indexOf("nosuch") + 1 });
    expect((await failure(session.run("SELECT 1 FROM parent WHERE", 100))).where).toEqual({});
  });

  it("refuses ATTACH, which would open another file on the session", async () => {
    const session = await open(seed());
    expect((await failure(session.run("ATTACH DATABASE '/tmp/x.db' AS x", 100))).message).toBe("ATTACH and DETACH are not allowed");
  });

  it("keeps a file opened from the filesystem below the run's own limit", async () => {
    const session = await open(seed(), { maxQueryRows: 2 });
    const { resultSets } = await session.run("SELECT id FROM parent", 1_000);
    expect(resultSets[0]!.rows).toEqual([[1], [2]]);
    expect(resultSets[0]!.truncated).toBe(true);
  });

  it("returns a 64-bit integer whole", async () => {
    const session = await open(seed());
    const { resultSets } = await session.run("SELECT 9007199254740993 AS big", 100);
    expect(resultSets[0]!.rows).toEqual([["9007199254740993"]]);
    // RETURNING cannot be capped in SQL, so its rows are read off the statement itself.
    const returned = await session.run("INSERT INTO parent (id) VALUES (9007199254740993) RETURNING id", 100);
    expect(returned.resultSets[0]!.rows).toEqual([["9007199254740993"]]);
  });

  it("writes every row of an INSERT … RETURNING even when it shows fewer", async () => {
    const path = seed();
    const session = await open(path);
    const { resultSets } = await session.run("INSERT INTO parent (id) SELECT value FROM (SELECT 10 AS value UNION ALL SELECT 11 UNION ALL SELECT 12) RETURNING id", 2);
    expect(resultSets[0]!.rows).toHaveLength(2);
    expect(resultSets[0]!.truncated).toBe(true);
    expect(count(path, "parent")).toBe(8);
  });
});

describe("SQLite query session on a readonly connection", () => {
  it("refuses a write before it reaches the file, and still reads", async () => {
    const path = seed();
    const session = await open(path, { readonly: true });
    const error = await failure(session.run("DELETE FROM child", 100));
    expect(error.cause).toBeInstanceOf(ReadonlyViolationError);
    expect(isReadonlyRefusal(error.cause)).toBe(true);
    expect((await session.run("SELECT COUNT(*) AS n FROM child", 100)).resultSets[0]!.rows).toEqual([[1]]);
    expect(count(path, "child")).toBe(1);
  });
});
