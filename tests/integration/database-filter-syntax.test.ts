/**
 * The filter row end to end: text typed in DBGate's syntax, read by the shared
 * parser into the request the browser sends, answered by the grid routes on a
 * real database. SQLite always runs; Postgres, MySQL and MariaDB run when their
 * URLs name disposable servers, as in database-grid-postgres.test.ts and
 * database-mysql.test.ts:
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-filter-syntax.test.ts
 *
 * Every database gets the same rows, dated around the current month on the
 * device's calendar, so `THIS MONTH` is tested at both of its edges.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import mysql2 from "mysql2/promise";
import postgres from "postgres";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { mysqlService } from "../../src/services/mysql.service.ts";
import { postgresService } from "../../src/services/postgres.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { closeAuditDb, getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import { classifyColumnType } from "../../src/shared/db-column-kind.ts";
import { parseAnyColumnFilter, parseFilter } from "../../src/shared/db-filter-parser.ts";
import type { FilterGroup, GridResponse, GridValuesResponse } from "../../src/shared/db-grid.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const app = () => new Hono().route("/db", databaseRoutes);

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method,
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

const pad = (n: number) => String(n).padStart(2, "0");
const wall = (d: Date, ms = "") => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms}`;

/** The device's UTC offset at that moment, as a Postgres literal wants it. */
function offsetOf(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

interface Row {
  id: number;
  name: string;
  qty: number | null;
  /** Wall-clock time and the fraction of a second after it, written the same on every engine. */
  created: [Date, string] | null;
  due: string | null;
}

/**
 * Six rows around the current month. `created` sits on the month's first
 * instant, inside it twice a quarter of a second apart, on the last second of
 * the month before and on the first instant of the next one.
 */
function seedRows(): Row[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return [
    { id: 1, name: "apple", qty: 5, created: [new Date(y, m, 1, 0, 0, 0), ""], due: "2026-09-27" },
    { id: 2, name: "Banana", qty: 10, created: [new Date(y, m, 15, 12, 0, 0), ".25"], due: null },
    { id: 3, name: "avocado abc", qty: 11, created: [new Date(y, m, 0, 23, 59, 59), ""], due: "2026-01-01" },
    { id: 4, name: "cherry", qty: 4, created: [new Date(y, m + 1, 1, 0, 0, 0), ""], due: null },
    { id: 5, name: "blueberry", qty: null, created: null, due: null },
    { id: 6, name: "date twin", qty: null, created: [new Date(y, m, 15, 12, 0, 0), ".75"], due: null },
  ];
}

interface Engine {
  type: DbType;
  url: string | undefined;
  /** Creates the table and a connection to it; answers the connection id and the schema to name. */
  setup(rows: Row[]): Promise<{ id: number; schema?: string }>;
  teardown(): Promise<void>;
}

const sqliteDirs: string[] = [];
const pg = process.env.PPM_TEST_PG_URL ? postgres(process.env.PPM_TEST_PG_URL, { max: 1, onnotice: () => {} }) : null;
const PG_SCHEMA = `ppm_filter_${RUN}`;

function mysqlEngine(type: "mysql" | "mariadb", url: string | undefined): Engine {
  const db = `ppm_filter_${type}_${RUN}`;
  let admin: mysql2.Connection | null = null;
  return {
    type,
    url,
    async setup(rows) {
      admin = await mysql2.createConnection({ uri: url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
      await admin.query(`CREATE DATABASE ${db} CHARACTER SET utf8mb4; USE ${db};
        CREATE TABLE films (id INT PRIMARY KEY, name VARCHAR(50), qty INT, created DATETIME(3), due DATE);`);
      for (const r of rows) {
        await admin.query("INSERT INTO films VALUES (?, ?, ?, ?, ?)", [r.id, r.name, r.qty, r.created ? wall(...r.created) : null, r.due]);
      }
      const id = insertConnection(type, `${type}-filter`, { type, connectionString: `${url!.replace(/\/$/, "")}/${db}` }).id;
      return { id, schema: db };
    },
    async teardown() {
      await admin?.query(`DROP DATABASE IF EXISTS ${db}`);
      await admin?.end();
    },
  };
}

const ENGINES: Engine[] = [
  {
    type: "sqlite",
    url: "always",
    async setup(rows) {
      const dir = mkdtempSync(join(tmpdir(), "ppm-filter-syntax-"));
      sqliteDirs.push(dir);
      const path = join(dir, "films.db");
      const db = new Database(path);
      db.exec("CREATE TABLE films (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, created DATETIME, due DATE)");
      const insert = db.prepare("INSERT INTO films VALUES (?, ?, ?, ?, ?)");
      // Milliseconds written the way JavaScript writes them, which is how they usually land in SQLite.
      for (const r of rows) insert.run(r.id, r.name, r.qty, r.created ? wall(r.created[0], r.created[1] && r.created[1].padEnd(4, "0")) : null, r.due);
      db.close();
      return { id: insertConnection("sqlite", "sqlite-filter", { type: "sqlite", path }).id };
    },
    async teardown() {},
  },
  {
    type: "postgres",
    url: process.env.PPM_TEST_PG_URL,
    async setup(rows) {
      await pg!.unsafe(`CREATE SCHEMA ${PG_SCHEMA};
        CREATE TABLE ${PG_SCHEMA}.films (id int PRIMARY KEY, name text, qty int, created timestamp, due date, at timestamptz)`);
      // Literals, not parameters: postgres.js's own serializer reads a string bound to a timestamp
      // through `new Date()`, i.e. in this process's zone, and stores it shifted to UTC. (PPM's
      // service replaces that serializer; this admin client keeps the default.)
      const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);
      const values = rows.map((r) => {
        const created = r.created ? wall(...r.created) : null;
        // `at` is the same moment as `created`, as an instant in the device's zone.
        const at = r.created ? `${created}${offsetOf(r.created[0])}` : null;
        return `(${[r.id, r.name, r.qty, created, r.due, at].map(lit).join(", ")})`;
      });
      await pg!.unsafe(`INSERT INTO ${PG_SCHEMA}.films VALUES ${values.join(", ")}`);
      return { id: insertConnection("postgres", "pg-filter", { type: "postgres", connectionString: process.env.PPM_TEST_PG_URL! }).id, schema: PG_SCHEMA };
    },
    async teardown() {
      await pg!.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    },
  },
  mysqlEngine("mysql", process.env.PPM_TEST_MYSQL_URL),
  mysqlEngine("mariadb", process.env.PPM_TEST_MARIADB_URL),
];

// bun test runs in UTC, where a bound that ignored the device's zone would still look right.
const originalTz = process.env.TZ;

beforeAll(async () => {
  process.env.TZ = "Asia/Ho_Chi_Minh";
  initAdapters();
  setDb(openTestDb());
  getAuditDb();
  if (process.env.PPM_TEST_MYSQL_URL || process.env.PPM_TEST_MARIADB_URL) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  // Assigned back, never deleted: once TZ is deleted, Bun ignores every later
  // assignment and the rest of the run stays in this zone.
  process.env.TZ = originalTz ?? "UTC";
  await postgresService.closeAll();
  await mysqlService.closeAll();
  await pg?.end();
  closeAuditDb();
  for (const dir of sqliteDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`filter syntax on ${engine.type}`, () => {
    let id = 0;
    let schema: string | undefined;
    let kinds: Map<string, ReturnType<typeof classifyColumnType>>;

    beforeAll(async () => {
      ({ id, schema } = await engine.setup(seedRows()));
      // The kinds come from the column list the browser reads, classified as it classifies them.
      const cols = await call<{ name: string; type: string }[]>("GET", `/db/connections/${id}/schema?table=films${schema ? `&schema=${schema}` : ""}`);
      kinds = new Map(cols.data.map((c) => [c.name, classifyColumnType(engine.type, c.type)]));
    });

    afterAll(() => engine.teardown());

    /** What the filter row sends for `text` typed under `column`. */
    function typed(column: string, text: string): FilterGroup {
      const read = parseFilter(text, kinds.get(column)!);
      if (!read.ok) throw new Error(`${text}: ${read.error.message}`);
      return { column, anyOf: read.anyOf };
    }

    function anyColumn(text: string): FilterGroup[] {
      const read = parseAnyColumnFilter(text, [...kinds].map(([name, kind]) => ({ name, kind })));
      if (!read.ok) throw new Error(`${text}: ${read.error.message}`);
      return read.groups;
    }

    async function ids(body: { filters?: FilterGroup[]; anyColumn?: FilterGroup[] }): Promise<number[]> {
      const res = await call<GridResponse>("POST", `/db/connections/${id}/grid`, { table: "films", schema, sort: [{ column: "id", dir: "ASC" }], ...body });
      if (res.status !== 200) throw new Error(`${res.status}: ${res.error}`);
      return res.data.rows.map((row) => Number(row[0]));
    }

    const values = async (body: object) => {
      const res = await call<GridValuesResponse>("POST", `/db/connections/${id}/grid/values`, { table: "films", schema, ...body });
      if (res.status !== 200) throw new Error(`${res.status}: ${res.error}`);
      return res.data;
    };

    it("reads the columns the way the browser does", () => {
      expect(kinds.get("qty")).toBe("number");
      expect(kinds.get("name")).toBe("text");
      expect(kinds.get("created")).toBe("datetime");
      expect(kinds.get("due")).toBe("date");
    });

    it(">=5 <=10 keeps the numbers in between, both ends included", async () => {
      expect(await ids({ filters: [typed("qty", ">=5 <=10")] })).toEqual([1, 2]);
    });

    it("^a, ^b keeps either beginning, whatever the case", async () => {
      expect(await ids({ filters: [typed("name", "^a, ^b")] })).toEqual([1, 2, 3, 5]);
    });

    it("~a keeps what does not contain it, whatever the case", async () => {
      expect(await ids({ filters: [typed("name", "~a")] })).toEqual([4, 5]);
    });

    it("THIS MONTH keeps the month's first instant and not the instants either side", async () => {
      expect(await ids({ filters: [typed("created", "THIS MONTH")] })).toEqual([1, 2, 6]);
    });

    // Only Postgres has a column type that holds an instant and prints it in a zone.
    it.skipIf(engine.type !== "postgres")("THIS MONTH on an instant compares with the device's midnight", async () => {
      expect(kinds.get("at")).toBe("datetimetz");
      expect(await ids({ filters: [typed("at", "THIS MONTH")] })).toEqual([1, 2, 6]);
    });

    it("columns filter together with AND", async () => {
      expect(await ids({ filters: [typed("name", "a"), typed("created", "THIS MONTH")] })).toEqual([1, 2, 6]);
      expect(await ids({ filters: [typed("name", "a"), typed("qty", ">=5 <=10")] })).toEqual([1, 2]);
    });

    it("the Multi column filter keeps a row that matches in one column only", async () => {
      expect(await ids({ anyColumn: anyColumn("2026-09-27") })).toEqual([1]);
    });

    it("the Multi column filter skips the columns the text means nothing to", async () => {
      const groups = anyColumn("abc");
      expect(groups.map((g) => g.column)).toEqual(["name"]);
      expect(await ids({ anyColumn: groups })).toEqual([3]);
    });

    it("the Multi column filter and the column filters hold together", async () => {
      expect(await ids({ anyColumn: anyColumn("a"), filters: [typed("qty", ">=5 <=10")] })).toEqual([1, 2]);
    });

    it("lists a column's distinct values, NULL among them", async () => {
      const qty = await values({ column: "qty" });
      expect(qty.values.filter((v) => v !== null).map(Number)).toEqual([4, 5, 10, 11]);
      expect(qty.values.filter((v) => v === null)).toHaveLength(1);
      expect(qty.hasMore).toBe(false);
      expect(new Set((await values({ column: "name" })).values)).toEqual(new Set(["apple", "Banana", "avocado abc", "cherry", "blueberry", "date twin"]));
    });

    it("lists the values the other filters leave, and those a search finds", async () => {
      expect(new Set((await values({ column: "name", filters: [typed("qty", ">=5 <=10")] })).values)).toEqual(new Set(["apple", "Banana"]));
      expect((await values({ column: "name", search: "AN" })).values).toEqual(["Banana"]);
      expect((await values({ column: "name", anyColumn: anyColumn("2026-09-27") })).values).toEqual(["apple"]);
    });

    it("a value picked from the list filters to its own rows, to the millisecond", async () => {
      const listed = (await values({ column: "created" })).values.filter((v): v is string => typeof v === "string");
      const quarter = listed.find((v) => /12:00:00\.25/.test(v));
      expect(quarter).toBeDefined();
      // What "Choose value" writes into the filter cell.
      expect(await ids({ filters: [typed("created", `="${quarter}"`)] })).toEqual([2]);
    });

    it.skipIf(engine.type !== "postgres")("a timestamptz picked from the list, as the database prints it, filters to its row", async () => {
      const listed = (await values({ column: "at" })).values.filter((v): v is string => typeof v === "string");
      expect(listed).toHaveLength(5);
      for (const v of listed) expect((await ids({ filters: [typed("at", `="${v}"`)] })).length).toBe(1);
    });
  });
}

describe("grid values on SQLite: limits, readonly and audit", () => {
  let dir: string;
  let path: string;
  const post = (connId: number, body: object) => call<GridValuesResponse>("POST", `/db/connections/${connId}/grid/values`, { table: "nums", ...body });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-filter-values-"));
    sqliteDirs.push(dir);
    path = join(dir, "nums.db");
    const db = new Database(path);
    db.exec("CREATE TABLE nums (n INTEGER, label TEXT)");
    const insert = db.prepare("INSERT INTO nums VALUES (?, ?)");
    for (let n = 1; n <= 150; n++) insert.run(n, `label ${n % 3}`);
    db.close();
  });

  it("sends at most 100 values and says more exist", async () => {
    const connId = insertConnection("sqlite", "nums", { type: "sqlite", path }).id;
    const res = await post(connId, { column: "n" });
    expect(res.status).toBe(200);
    expect(res.data.values).toHaveLength(100);
    expect(res.data.values[0]).toBe(1);
    expect(res.data.values[99]).toBe(100);
    expect(res.data.hasMore).toBe(true);
    expect(res.data.sql).toBe(`SELECT DISTINCT "n"\nFROM "nums"\nORDER BY "n"`);
    const exactly = await post(connId, { column: "n", filters: [{ column: "n", anyOf: [[{ op: "le", value: 100 }]] }] });
    expect(exactly.data.values).toHaveLength(100);
    expect(exactly.data.hasMore).toBe(false);
    const few = await post(connId, { column: "label" });
    expect(few.data).toEqual({ values: ["label 0", "label 1", "label 2"], hasMore: false, sql: `SELECT DISTINCT "label"\nFROM "nums"\nORDER BY "label"` });
  });

  it("answers 400 for a column the table does not have, and 404 for a table that is not there", async () => {
    const connId = insertConnection("sqlite", "nums-bad", { type: "sqlite", path }).id;
    expect((await post(connId, { column: "nope" })).status).toBe(400);
    expect((await post(connId, { column: "n", table: "missing" })).status).toBe(404);
    expect((await post(connId, {})).error).toBe("column is required");
  });

  it("blocks an SQL condition that writes on a readonly connection, and logs the attempt", async () => {
    getAuditDb().exec("DELETE FROM query_log");
    const ro = insertConnection("sqlite", "nums-ro", { type: "sqlite", path }).id;
    const res = await post(ro, { column: "n", filters: [{ column: "label", anyOf: [[{ op: "rawSql", sql: "$$ IN (SELECT 1 FROM nums WHERE 1 = 1) OR 1 = (DELETE FROM nums)" }]] }] });
    expect(res.status).toBe(403);
    const [entry] = listQueryLogs({ connectionId: ro });
    expect(entry?.status).toBe("blocked");
    expect(entry?.source).toBe("filter");
  });

  it("logs a filtered or searched list as filter SQL and leaves a plain one out", async () => {
    getAuditDb().exec("DELETE FROM query_log");
    const connId = insertConnection("sqlite", "nums-audit", { type: "sqlite", path }).id;
    updateConnection(connId, { readonly: 0 });
    await post(connId, { column: "label" });
    expect(listQueryLogs({ connectionId: connId })).toHaveLength(0);
    await post(connId, { column: "label", search: "1" });
    await post(connId, { column: "label", filters: [{ column: "n", anyOf: [[{ op: "lt", value: 3 }]] }] });
    await post(connId, { column: "label", anyColumn: [{ column: "n", anyOf: [[{ op: "eq", value: 7 }]] }] });
    const entries = listQueryLogs({ connectionId: connId });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.source === "filter" && e.status === "ok")).toBe(true);
    expect(entries.map((e) => e.sql).sort()).toEqual([
      `SELECT DISTINCT "label"\nFROM "nums"\nWHERE "label" LIKE '%1%' ESCAPE '\\'\nORDER BY "label"`,
      `SELECT DISTINCT "label"\nFROM "nums"\nWHERE "n" < 3\nORDER BY "label"`,
      `SELECT DISTINCT "label"\nFROM "nums"\nWHERE "n" = 7\nORDER BY "label"`,
    ]);
  });

  it("logs a page read through the Multi column filter alone", async () => {
    getAuditDb().exec("DELETE FROM query_log");
    const connId = insertConnection("sqlite", "nums-any", { type: "sqlite", path }).id;
    const res = await call<GridResponse>("POST", `/db/connections/${connId}/grid`, { table: "nums", anyColumn: [{ column: "n", anyOf: [[{ op: "eq", value: 7 }]] }] });
    expect(res.data.rows.map((row) => row[0])).toEqual([7]);
    const [entry] = listQueryLogs({ connectionId: connId });
    expect(entry?.source).toBe("filter");
    expect(entry?.sql).toContain(`WHERE "n" = 7`);
  });
});
