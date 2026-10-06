/**
 * Copy as SQL INSERTs / UPDATEs, run back against the database the rows came from. The rows are read
 * through POST grid and GET schema as the data tab reads them and written by the browser's own
 * copy-as; the text is then pasted into a Query tab and run a statement at a time, as its Run current
 * statement (Ctrl+Enter) sends them. What the grid reads afterwards must be what was copied.
 *
 * SQLite runs everywhere. Postgres, MySQL and MariaDB run only when their URLs name disposable
 * servers, as in database-grid-export-postgres.test.ts and database-grid-export-mysql.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import mysql2 from "mysql2/promise";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { postgresService } from "../../src/services/postgres.service.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { sqliteService } from "../../src/services/sqlite.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { classifyColumnType } from "../../src/shared/db-column-kind.ts";
import { rowsToRecords, type GridResponse, type QueryRunResponse } from "../../src/shared/db-grid.ts";
import type { DbType, DialectName } from "../../src/shared/db-types.ts";
import { getStatementAtCursor, splitSqlStatementsWithLines } from "../../src/shared/split-sql-statements.ts";
import { formatCopy, type CopyFormat, type CopySqlTarget } from "../../src/web/components/database/grid/copy-as.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const app = () => new Hono().route("/db", databaseRoutes);

interface Table { connId: number; table: string; schema: string; dialect: DialectName }

async function readGrid(t: Table): Promise<Record<string, unknown>[] & { rowKey?: string[]; keys?: string[] }> {
  const res = await app().request(`/db/connections/${t.connId}/grid`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify({ table: t.table, schema: t.schema, sort: [{ column: "id", dir: "ASC" }], limit: 100 }),
  });
  const json = (await res.json()) as { data: GridResponse; error?: string };
  expect(json.error).toBeUndefined();
  const { keys, records } = rowsToRecords(json.data.columns, json.data.rows);
  return Object.assign(records, { rowKey: json.data.rowKey, keys });
}

async function readColumns(t: Table): Promise<{ name: string; type: string }[]> {
  const res = await app().request(
    `/db/connections/${t.connId}/schema?table=${encodeURIComponent(t.table)}${t.schema ? `&schema=${encodeURIComponent(t.schema)}` : ""}`,
  );
  const json = (await res.json()) as { data: { name: string; type: string }[]; error?: string };
  expect(json.error).toBeUndefined();
  return json.data;
}

/**
 * Copy advanced ▸ `format` with rows `ids` selected across every column, built as the data tab
 * builds it: each row's values in the grid's column order, the table's own key to find it by.
 */
async function copyRows(t: Table, ids: string[], format: CopyFormat): Promise<{ text: string; copied: Record<string, unknown>[] }> {
  const rows = await readGrid(t);
  const columns = await readColumns(t);
  const shown = rows.keys!.filter((k) => columns.some((c) => c.name === k));
  const copied = rows.filter((r) => ids.includes(String(r.id)));
  expect(copied).toHaveLength(ids.length);
  const target: CopySqlTarget = {
    table: t.table, schema: t.schema, dialect: t.dialect, keyColumns: rows.rowKey!,
    kinds: new Map(columns.map((c) => [c.name, classifyColumnType(t.dialect as DbType, c.type)])),
  };
  const now = copied.map((r) => Object.fromEntries(columns.map((c) => [c.name, r[c.name]])));
  return { text: formatCopy(format, { columns: shown, rows: now, stored: copied }, target), copied };
}

/**
 * The text pasted into a Query tab, each statement run with the cursor on its first line — what
 * Run current statement sends. Answers how many statements there were and how many rows each changed.
 */
async function runPasted(t: Table, pasted: string): Promise<number[]> {
  const affected: number[] = [];
  for (const statement of splitSqlStatementsWithLines(pasted, t.dialect)) {
    const sql = getStatementAtCursor(pasted, statement.startLine, t.dialect);
    const res = await app().request(`/db/connections/${t.connId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
      body: JSON.stringify({ sql }),
    });
    const json = (await res.json()) as { data: QueryRunResponse; error?: string };
    expect({ sql, status: res.status, error: json.error }).toEqual({ sql, status: 200, error: undefined });
    affected.push(json.data.rowsAffected);
  }
  return affected;
}

/**
 * The round trips every engine must survive: rows copied as INSERTs, deleted and pasted back; rows
 * copied as UPDATEs, scrambled and pasted back. A third row is never copied and must not move.
 */
function roundTrips(table: () => Table, ids: string[], run: (sql: string) => Promise<void>, scramble: string, remove: string) {
  it("pastes Copy as SQL INSERTs back as the rows that were copied", async () => {
    const t = table();
    const before = await readGrid(t);
    const { text, copied } = await copyRows(t, ids, "inserts");
    await run(remove);
    expect((await readGrid(t)).map((r) => String(r.id))).not.toContain(ids[0]);

    expect(await runPasted(t, text)).toEqual(ids.map(() => 1));
    const after = await readGrid(t);
    expect(after.filter((r) => ids.includes(String(r.id)))).toEqual(copied);
    expect([...after]).toEqual([...before]);
  });

  it("pastes Copy as SQL UPDATEs back over rows changed since", async () => {
    const t = table();
    const before = await readGrid(t);
    const { text, copied } = await copyRows(t, ids, "updates");
    await run(scramble);
    expect((await readGrid(t)).filter((r) => ids.includes(String(r.id)))).not.toEqual(copied);

    expect(await runPasted(t, text)).toEqual(ids.map(() => 1));
    expect([...(await readGrid(t))]).toEqual([...before]);
  });
}

describe("Copy as SQL on SQLite, run in a Query tab", () => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-copy-sql-"));
  const path = join(dir, "target.db");
  let connId = 0;
  const admin = () => new Database(path);
  const run = async (sql: string) => {
    const db = admin();
    try { db.exec(sql); } finally { db.close(); }
  };

  beforeAll(() => {
    initAdapters();
    setDb(openTestDb());
    const db = admin();
    db.exec(`CREATE TABLE kinds (id INTEGER PRIMARY KEY, label TEXT, n NUMERIC, f REAL, big INTEGER, ok BOOLEAN, ts DATETIME, j JSON, b BLOB)`);
    const insert = db.prepare("INSERT INTO kinds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(1, `it's "quoted"; a \\ backslash`, 1.5, 0.1, 9007199254740993n, 1, "2024-01-01 10:00:00", `{"k": [1, 2], "s": "it's"}`, new Uint8Array([0x00, 0xff, 0x27]));
    insert.run(2, "two\nlines; DELETE FROM kinds", null, null, -9007199254740993n, 0, null, null, null);
    insert.run(3, "never copied", 3, 3.25, 3, 1, "2024-03-03 03:03:03", "[]", new Uint8Array([3]));
    db.close();
    connId = insertConnection("sqlite", "copy-sql", { type: "sqlite", path }).id;
    updateConnection(connId, { readonly: 0 });
  });

  afterAll(() => {
    sqliteService.closeAll();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  });

  roundTrips(
    () => ({ connId, table: "kinds", schema: "", dialect: "sqlite" }), ["1", "2"], run,
    "UPDATE kinds SET label = 'x', n = 0, f = 0, big = 0, ok = NULL, ts = NULL, j = NULL, b = NULL WHERE id IN (1, 2)",
    "DELETE FROM kinds WHERE id IN (1, 2)",
  );
});

const PG_URL = process.env.PPM_TEST_PG_URL;

describe.skipIf(!PG_URL)("Copy as SQL on Postgres, run in a Query tab", () => {
  const S = `ppm_copy_sql_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  let connId = 0;
  const run = async (sql: string) => { await admin!.unsafe(sql); };

  beforeAll(async () => {
    initAdapters();
    setDb(openTestDb());
    await admin!.unsafe(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.kinds (
        id int8 PRIMARY KEY, label text, n numeric, f float8, j jsonb, b bytea, ts timestamp, tz timestamptz,
        u uuid, ok boolean, d date, tags int[], words text[], grid int[][], uids uuid[], blobs bytea[], flags bool[]
      );
      INSERT INTO ${S}.kinds VALUES
        (1, E'it''s "quoted"; a \\\\ backslash', 12345678901234567890.1234567891, 0.1, '[1, {"k": "v"}]',
          '\\x00ff27', '2024-01-01 10:00:00.123456', '2024-01-01 10:00:00+07', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          true, '2024-02-29', '{1,2}', ARRAY['a,b', 'say "hi"', E'back\\\\slash', '{brace}', NULL, 'NULL', '', ' padded ', 'it''s'],
          '{{1,2},{3,4}}', ARRAY['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid], ARRAY['\\x00ff'::bytea, NULL], '{t,f,NULL}'),
        (9007199254740993, E'two\\nlines; DELETE FROM kinds', NULL, 'NaN', '{"k": [1, 2], "s": "it''s"}', NULL, NULL, NULL, NULL,
          false, NULL, '{}', '{}', NULL, NULL, NULL, NULL),
        (3, 'never copied', 3, 3.25, '[]', '\\x03', '2024-03-03 03:03:03', '2024-03-03 03:03:03+00',
          'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', true, '2024-03-03', '{3}', '{c}', '{{5}}', NULL, NULL, '{t}');
    `);
    connId = insertConnection("postgres", "copy-sql-pg", { type: "postgres", connectionString: PG_URL! }).id;
    updateConnection(connId, { readonly: 0 });
  });

  afterAll(async () => {
    await postgresService.closeAll();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin!.end();
  });

  // postgres.js reads a NULL element as the text "NULL" (a bool[]'s as false, a bytea[]'s as no bytes),
  // and a copy of the row would then write those back: see postgres-array-nulls.ts.
  it("reads a NULL inside an array as NULL, apart from the text 'NULL'", async () => {
    const row = (await readGrid({ connId, table: "kinds", schema: S, dialect: "postgres" })).find((r) => String(r.id) === "1")!;
    expect(row.words).toEqual(["a,b", 'say "hi"', "back\\slash", "{brace}", null, "NULL", "", " padded ", "it's"]);
    expect(row.flags).toEqual([true, false, null]);
    expect(row.blobs).toEqual([{ $binary: "AP8=", size: 2 }, null]);
    expect(row.grid).toEqual([[1, 2], [3, 4]]);
  });

  it("reads them so in a Query tab too, bounds and box arrays included", async () => {
    const res = await app().request(`/db/connections/${connId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
      body: JSON.stringify({
        sql: `SELECT ARRAY[1, NULL]::int[] AS a, '[0:1]={7,8}'::int[] AS b, '{"NULL",NULL,null}'::text[] AS c,
          ARRAY['(1,1),(0,0)'::box, NULL] AS d, ARRAY[NULL]::bool[] AS e, '{}'::int[] AS f, ARRAY[ARRAY[NULL, 2]]::int[] AS g`,
      }),
    });
    const { data } = (await res.json()) as { data: QueryRunResponse };
    expect(data.rows).toEqual([[[1, null], [7, 8], ["NULL", null, null], ["(1,1),(0,0)", null], [null], [], [[null, 2]]]]);
  });

  roundTrips(
    () => ({ connId, table: "kinds", schema: S, dialect: "postgres" }), ["1", "9007199254740993"], run,
    `UPDATE ${S}.kinds SET label = 'x', n = 0, f = 0, j = NULL, b = NULL, ts = NULL, tz = NULL, u = NULL, ok = NULL, d = NULL,
      tags = '{9}', words = '{x}', grid = '{{9}}', uids = NULL, blobs = '{}', flags = '{f}'
      WHERE id IN (1, 9007199254740993)`,
    `DELETE FROM ${S}.kinds WHERE id IN (1, 9007199254740993)`,
  );
});

const MYSQL_ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

for (const engine of MYSQL_ENGINES) {
  describe.skipIf(!engine.url)(`Copy as SQL on ${engine.type}, run in a Query tab`, () => {
    const DB = `ppm_copy_sql_${engine.type}_${RUN}`;
    let admin: mysql2.Connection;
    let connId = 0;
    const run = async (sql: string) => { await admin.query(sql); };

    beforeAll(async () => {
      initAdapters();
      await installDbDriver("mysql", { run: copyingRunner("mysql") });
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
      await admin.query(`
        CREATE DATABASE ${DB} CHARACTER SET utf8mb4;
        USE ${DB};
        CREATE TABLE kinds (
          id BIGINT PRIMARY KEY, label VARCHAR(80), amount DECIMAL(30,10), ratio FLOAT, flags BIT(8), active TINYINT(1),
          created DATETIME(3), day DATE, doc JSON, photo BLOB
        );
        INSERT INTO kinds VALUES
          (1, 'it''s "quoted"; a \\\\ backslash', 12345678901234567890.1234567891, 1.1, b'00000101', 1,
            '2024-01-01 10:00:00.123', '2024-02-29', '{"k": [1, 2], "s": "it''s"}', X'00FF27'),
          (9007199254740993, 'two\\nlines; DELETE FROM kinds', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL),
          (3, 'never copied', 3, 3.25, b'00000011', 1, '2024-03-03 03:03:03.000', '2024-03-03', '[]', X'03');
      `);
      setDb(openTestDb());
      const url = `${engine.url!.replace(/\/$/, "")}/${DB}`;
      connId = insertConnection(engine.type, `copy-sql-${engine.type}`, { type: engine.type, connectionString: url }).id;
      updateConnection(connId, { readonly: 0 });
    });

    afterAll(async () => {
      await mysqlService.closeAll();
      await readonlyMysqlService.closeAll();
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    });

    roundTrips(
      () => ({ connId, table: "kinds", schema: DB, dialect: "mysql" }), ["1", "9007199254740993"], run,
      `UPDATE kinds SET label = 'x', amount = 0, ratio = 0, flags = NULL, active = NULL, created = NULL, day = NULL, doc = NULL, photo = NULL
        WHERE id IN (1, 9007199254740993)`,
      "DELETE FROM kinds WHERE id IN (1, 9007199254740993)",
    );
  });
}
