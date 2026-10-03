import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { closeAuditDb, getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { GridCountResponse, GridResponse, QueryRunResponse } from "../../src/shared/db-grid.ts";

const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;
let targetDbPath: string;

function isolatePpmHome(): void {
  const home = mkdtempSync(join(tmpdir(), "ppm-grid-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
}

function seedTargetDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-grid-target-"));
  tempDirs.push(dir);
  const path = join(dir, "target.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, big INTEGER, active BOOLEAN, created DATETIME, data BLOB)`);
  const insert = db.prepare("INSERT INTO items (id, name, qty, big, active, created, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run(1, "Apple", 5, 1, 1, "2024-02-14 23:59:59", null);
  insert.run(2, "banana", 12, 2, 0, "2024-02-15", null);
  insert.run(3, "Cherry 50%", null, 9007199254740993n, 1, "2024-02-15T10:00:00", new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  insert.run(4, "apple pie", 7, 4, 0, "2024-02-15 23:59:59.500", null);
  insert.run(5, "", 3, 5, 1, "2024-02-16", null);
  // Names a regex-checked identifier could not express.
  db.exec(`CREATE TABLE "đơn hàng" ("mã-đơn" INTEGER, "Tên ""khách""" TEXT, "ghi chú" TEXT)`);
  db.exec(`INSERT INTO "đơn hàng" VALUES (1, 'Nguyễn Văn A', 'giao sáng'), (2, 'Trần B', NULL)`);
  db.close();
  return path;
}

const app = () => new Hono().route("/db", databaseRoutes);

async function createConnection(readonly = false): Promise<number> {
  const res = await app().request("/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sqlite", name: readonly ? "grid-ro" : "grid-rw", connectionConfig: { type: "sqlite", path: targetDbPath } }),
  });
  const id = ((await res.json()) as { data: { id: number } }).data.id;
  if (!readonly) {
    await app().request(`/db/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });
  }
  return id;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

const grid = (id: number, body: unknown) => post<GridResponse>(`/db/connections/${id}/grid`, body);
const ids = (r: GridResponse) => r.rows.map((row) => row[0]);

beforeEach(() => {
  isolatePpmHome();
  initAdapters();
  setDb(openTestDb());
  targetDbPath = seedTargetDb();
  getAuditDb();
});

afterAll(() => {
  closeAuditDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("POST /connections/:id/grid on SQLite", () => {
  it("answers columns in catalog order with declared types, rows as arrays", async () => {
    const id = await createConnection();
    const { status, data } = await grid(id, { table: "items" });
    expect(status).toBe(200);
    expect(data.columns).toEqual([
      { name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" }, { name: "qty", type: "INTEGER" },
      { name: "big", type: "INTEGER" }, { name: "active", type: "BOOLEAN" }, { name: "created", type: "DATETIME" },
      { name: "data", type: "BLOB" },
    ]);
    expect(data.rows[0]).toEqual([1, "Apple", 5, 1, 1, "2024-02-14 23:59:59", null]);
    expect(data.hasMore).toBe(false);
    expect(data.sql).toBe(`SELECT "id", "name", "qty", "big", "active", "created", "data"\nFROM "items"`);
  });

  it("keeps an integer past 2^53 exact and sends bytes as a sized marker", async () => {
    const id = await createConnection();
    const { data } = await grid(id, { table: "items", filters: [{ column: "id", anyOf: [[{ op: "eq", value: 3 }]] }] });
    expect(data.rows[0]![3]).toBe("9007199254740993");
    expect(data.rows[0]![6]).toEqual({ $binary: "3q2+7w==", size: 4 });
  });

  it("pages with limit + offset and says whether more rows follow", async () => {
    const id = await createConnection();
    const first = await grid(id, { table: "items", sort: [{ column: "id", dir: "ASC" }], limit: 2 });
    expect(ids(first.data)).toEqual([1, 2]);
    expect(first.data.hasMore).toBe(true);
    const last = await grid(id, { table: "items", sort: [{ column: "id", dir: "ASC" }], limit: 2, offset: 4 });
    expect(ids(last.data)).toEqual([5]);
    expect(last.data.hasMore).toBe(false);
  });

  it("filters with contains, which SQLite used to reject as ILIKE", async () => {
    const id = await createConnection();
    const { status, data } = await grid(id, { table: "items", filters: [{ column: "name", anyOf: [[{ op: "contains", value: "APPLE" }]] }] });
    expect(status).toBe(200);
    expect(ids(data).sort()).toEqual([1, 4]);
    expect(data.sql).toContain(`"name" LIKE '%APPLE%' ESCAPE '\\'`);
    expect(data.sql).not.toContain("ILIKE");
  });

  it("matches % literally inside a contains filter", async () => {
    const id = await createConnection();
    const { data } = await grid(id, { table: "items", filters: [{ column: "name", anyOf: [[{ op: "contains", value: "50%" }]] }] });
    expect(ids(data)).toEqual([3]);
  });

  it("reads one column's groups as OR of ANDs and different columns as AND", async () => {
    const id = await createConnection();
    const { data } = await grid(id, {
      table: "items",
      sort: [{ column: "id", dir: "ASC" }],
      filters: [
        { column: "name", anyOf: [[{ op: "contains", value: "apple" }, { op: "contains", value: "pie" }], [{ op: "startsWith", value: "ban" }]] },
        { column: "qty", anyOf: [[{ op: "gt", value: 5 }]] },
      ],
    });
    expect(ids(data)).toEqual([2, 4]);
  });

  it("handles null, empty and boolean operators", async () => {
    const id = await createConnection();
    const run = async (column: string, op: string) => ids((await grid(id, { table: "items", sort: [{ column: "id", dir: "ASC" }], filters: [{ column, anyOf: [[{ op }]] }] })).data);
    expect(await run("qty", "isNull")).toEqual([3]);
    expect(await run("name", "isEmpty")).toEqual([5]);
    expect(await run("name", "notEmpty")).toEqual([1, 2, 3, 4]);
    expect(await run("active", "isTrue")).toEqual([1, 3, 5]);
    expect(await run("active", "isFalse")).toEqual([2, 4]);
  });

  it("compares dates stored as text in different shapes", async () => {
    const id = await createConnection();
    const { data } = await grid(id, {
      table: "items",
      sort: [{ column: "id", dir: "ASC" }],
      filters: [{ column: "created", anyOf: [[{ op: "dateRange", from: "2024-02-15", to: "2024-02-16" }]] }],
    });
    expect(ids(data)).toEqual([2, 3, 4]);
  });

  it("runs a raw SQL condition with $$ standing for the column, trailing comment and all", async () => {
    const id = await createConnection();
    const { status, data } = await grid(id, {
      table: "items",
      sort: [{ column: "id", dir: "DESC" }],
      filters: [{ column: "qty", anyOf: [[{ op: "rawSql", sql: "$$ % 2 = 1 -- odd quantities" }]] }],
    });
    expect(status).toBe(200);
    expect(ids(data)).toEqual([5, 4, 1]);
  });

  it("views and filters a table whose names need quoting", async () => {
    const id = await createConnection();
    const all = await grid(id, { table: "đơn hàng" });
    expect(all.status).toBe(200);
    // No primary key, so each row comes with the rowid that addresses it, last.
    expect(all.data.columns.map((c) => c.name)).toEqual(["mã-đơn", `Tên "khách"`, "ghi chú", "rowid"]);
    expect(all.data.rowKey).toEqual(["rowid"]);
    const filtered = await grid(id, { table: "đơn hàng", filters: [{ column: `Tên "khách"`, anyOf: [[{ op: "contains", value: "Nguyễn" }]] }] });
    expect(filtered.data.rows).toEqual([[1, "Nguyễn Văn A", "giao sáng", 1]]);
  });

  it("answers 400 for a column the table does not have", async () => {
    const id = await createConnection();
    const byFilter = await grid(id, { table: "items", filters: [{ column: "nope", anyOf: [[{ op: "isNull" }]] }] });
    expect(byFilter.status).toBe(400);
    expect(byFilter.error).toContain(`Unknown column "nope"`);
    const bySort = await grid(id, { table: "items", sort: [{ column: `id" DESC; DROP TABLE items; --`, dir: "ASC" }] });
    expect(bySort.status).toBe(400);
  });

  it("answers 404 for a table that does not exist and for an unknown connection", async () => {
    const id = await createConnection();
    expect((await grid(id, { table: "missing" })).status).toBe(404);
    expect((await grid(9999, { table: "items" })).status).toBe(404);
  });

  it("answers 400 for a body that cannot become SQL", async () => {
    const id = await createConnection();
    expect((await grid(id, "not json")).status).toBe(400);
    expect((await grid(id, { table: "items", limit: 0 })).status).toBe(400);
    expect((await grid(id, { table: "items", filters: [{ column: "qty", anyOf: [[{ op: "rawSql", sql: "$$ = 1; DELETE FROM items" }]] }] })).status).toBe(400);
  });
});

describe("POST /connections/:id/grid/count on SQLite", () => {
  it("counts the whole table and the filtered rows; SQLite keeps no estimate", async () => {
    const id = await createConnection();
    const all = await post<GridCountResponse>(`/db/connections/${id}/grid/count`, { table: "items" });
    expect(all.data).toEqual({ count: 5, estimate: null, timedOut: false });
    const some = await post<GridCountResponse>(`/db/connections/${id}/grid/count`, { table: "items", filters: [{ column: "name", anyOf: [[{ op: "contains", value: "apple" }]] }] });
    expect(some.data.count).toBe(2);
  });

  it("counts on request with `exact`, and refuses an `exact` that is not true or false", async () => {
    const id = await createConnection();
    const exact = await post<GridCountResponse>(`/db/connections/${id}/grid/count`, { table: "items", exact: true });
    expect(exact.data).toEqual({ count: 5, estimate: null, timedOut: false });
    const bad = await post(`/db/connections/${id}/grid/count`, { table: "items", exact: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.error).toBe("exact must be true or false");
  });
});

describe("Bun's idle cut", () => {
  // Bun.serve drops a request that sends nothing for 10 s; `server.timeout(req, s)` lifts that for one
  // request. The routes are handed the server as `env`, as `app.fetch(req, server)` does.
  async function heldFor(path: string, body: unknown): Promise<number[]> {
    const held: number[] = [];
    const server = { timeout: (req: Request, seconds: number) => { expect(req).toBeInstanceOf(Request); held.push(seconds); } };
    const res = await app().request(path, {
      method: "POST", headers: { "Content-Type": "application/json", "x-ppm-client": "web" }, body: JSON.stringify(body),
    }, server);
    expect(res.status).toBe(200);
    return held;
  }

  it("keeps a page read and a count open past it, a requested count far longer", async () => {
    const id = await createConnection();
    expect(await heldFor(`/db/connections/${id}/grid`, { table: "items" })).toEqual([300]);
    // The background count gives up at 10 s, so 10 s of silence was exactly where Bun cut it.
    expect(await heldFor(`/db/connections/${id}/grid/count`, { table: "items" })).toEqual([40]);
    expect(await heldFor(`/db/connections/${id}/grid/count`, { table: "items", exact: true })).toEqual([330]);
  });
});

describe("readonly connections", () => {
  it("blocks a raw SQL condition that is not a plain read, and logs the attempt", async () => {
    const id = await createConnection(true);
    const res = await grid(id, { table: "items", filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "$$ IN (SELECT id FROM items WHERE 1) OR (DELETE FROM items) IS NULL" }]] }] });
    expect(res.status).toBe(403);
    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("blocked");
    expect(logs[0]!.source).toBe("filter");
    expect(logs[0]!.sql).toContain("DELETE FROM items");
  });

  it("still allows raw SQL that only reads", async () => {
    const id = await createConnection(true);
    const res = await grid(id, { table: "items", filters: [{ column: "qty", anyOf: [[{ op: "rawSql", sql: "$$ > 6" }]] }] });
    expect(res.status).toBe(200);
    expect(ids(res.data).sort()).toEqual([2, 4]);
  });

  it("blocks the same condition on the count endpoint", async () => {
    const id = await createConnection(true);
    const res = await post(`/db/connections/${id}/grid/count`, { table: "items", filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "(DELETE FROM items) IS NULL" }]] }] });
    expect(res.status).toBe(403);
  });
});

describe("audit of grid reads", () => {
  it("logs a filtered page as filter SQL, with the statement that ran", async () => {
    const id = await createConnection();
    await grid(id, { table: "items", filters: [{ column: "qty", anyOf: [[{ op: "ge", value: 7 }]] }], limit: 10 });
    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.source).toBe("filter");
    expect(logs[0]!.operation).toBe("select");
    expect(logs[0]!.row_count).toBe(2);
    expect(logs[0]!.sql).toBe(`SELECT "id", "name", "qty", "big", "active", "created", "data"\nFROM "items"\nWHERE "qty" >= 7\nLIMIT 11 OFFSET 0`);
  });

  it("does not log browsing or counting", async () => {
    const id = await createConnection();
    await grid(id, { table: "items" });
    await grid(id, { table: "items", sort: [{ column: "name", dir: "DESC" }], offset: 2 });
    await post(`/db/connections/${id}/grid/count`, { table: "items", filters: [{ column: "qty", anyOf: [[{ op: "ge", value: 7 }]] }] });
    expect(listQueryLogs()).toHaveLength(0);
  });
});

describe("POST /connections/:id/query result shape", () => {
  it("keeps two result columns that share a name", async () => {
    const id = await createConnection();
    const { status, data } = await post<QueryRunResponse>(`/db/connections/${id}/query`, { sql: "SELECT 1 AS id, 2 AS b, 3 AS id" });
    expect(status).toBe(200);
    expect(data.columns.map((c) => c.name)).toEqual(["id", "b", "id"]);
    expect(data.rows).toEqual([[1, 2, 3]]);
  });

  it("describes the columns of a SELECT that returns no rows", async () => {
    const id = await createConnection();
    const { data } = await post<QueryRunResponse>(`/db/connections/${id}/query`, { sql: "SELECT * FROM items WHERE 0" });
    expect(data.columns.map((c) => c.name)).toEqual(["id", "name", "qty", "big", "active", "created", "data"]);
    expect(data.rows).toEqual([]);
    expect(data.changeType).toBe("select");
  });

  it("reports rows affected by a write", async () => {
    const id = await createConnection();
    const { data } = await post<QueryRunResponse>(`/db/connections/${id}/query`, { sql: "UPDATE items SET qty = 0 WHERE qty > 6" });
    expect(data).toMatchObject({ columns: [], rows: [], rowsAffected: 2, changeType: "modify" });
  });

  it("logs every value of a repeated column in the result sample", async () => {
    const id = await createConnection();
    await post(`/db/connections/${id}/query`, { sql: "SELECT 1 AS id, 2 AS id" });
    const head = listQueryLogs()[0]!.result_head ?? "";
    expect(head).toContain(`"id":1`);
    expect(head).toContain(`"id (2)":2`);
  });
});
