import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { getAuditDb, closeAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs, countQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";

const tempDirs: string[] = [];
let targetDbPath: string;

function isolatePpmHome(): void {
  const home = mkdtempSync(join(tmpdir(), "ppm-audit-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
}

/** A real sqlite file for the routes to run statements against. */
function seedTargetDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-audit-target-"));
  tempDirs.push(dir);
  const path = join(dir, "target.db");
  const db = new Database(path);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("INSERT INTO items (id, name) VALUES (1, 'first'), (2, 'second'), (3, 'referenced')");
  // Gives a bulk delete something that fails partway: item 3 cannot be removed.
  db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id))");
  db.exec("INSERT INTO child (id, item_id) VALUES (1, 3)");
  db.close();
  return path;
}

const app = () => new Hono().route("/db", databaseRoutes);

/** Connections are created readonly by default; writes need an explicit toggle, same as the UI. */
async function createConnection(readonly = false): Promise<number> {
  const res = await app().request("/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "sqlite",
      name: readonly ? "audit-readonly" : "audit-target",
      connectionConfig: { type: "sqlite", path: targetDbPath },
    }),
  });
  const json = await res.json() as { data: { id: number } };
  const id = json.data.id;

  if (!readonly) {
    await app().request(`/db/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });
  }
  return id;
}

function webRequest(path: string, init: RequestInit): Promise<Response> {
  return app().request(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-ppm-client": "web", ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  isolatePpmHome();
  initAdapters();
  setDb(openTestDb());
  targetDbPath = seedTargetDb();
  getAuditDb();
});

afterAll(() => {
  closeAuditDb();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("audit logging from database routes", () => {
  it("records a successful editor query with row count and result sample", async () => {
    const id = await createConnection();

    const res = await webRequest(`/db/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM items" }),
    });
    expect(res.status).toBe(200);

    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.source).toBe("editor");
    expect(logs[0]!.operation).toBe("select");
    expect(logs[0]!.status).toBe("ok");
    expect(logs[0]!.row_count).toBe(3);
    expect(logs[0]!.actor).toBe("human");
    expect(logs[0]!.result_head).toContain("first");
    expect(logs[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("marks a caller without the web header as an agent", async () => {
    const id = await createConnection();

    await app().request(`/db/connections/${id}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });

    expect(listQueryLogs()[0]!.actor).toBe("agent");
  });

  it("records failed statements with the error message", async () => {
    const id = await createConnection();

    const res = await webRequest(`/db/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM missing_table" }),
    });
    expect(res.status).toBe(500);

    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("error");
    expect(logs[0]!.error).toContain("missing_table");
  });

  it("records statements rejected by a readonly connection", async () => {
    const id = await createConnection(true);

    const res = await webRequest(`/db/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "DELETE FROM items WHERE id = 1" }),
    });
    expect(res.status).toBe(403);

    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("blocked");
    expect(logs[0]!.operation).toBe("delete");
  });

  it("records grid writes with the statement that ran", async () => {
    const id = await createConnection();

    await webRequest(`/db/connections/${id}/cell`, {
      method: "PUT",
      body: JSON.stringify({ table: "items", pkColumn: "id", pkValue: 1, column: "name", value: "renamed" }),
    });
    await webRequest(`/db/connections/${id}/row`, {
      method: "DELETE",
      body: JSON.stringify({ table: "items", pkColumn: "id", pkValue: 2 }),
    });

    const logs = listQueryLogs();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.source === "grid")).toBe(true);

    const update = logs.find((l) => l.operation === "update");
    const remove = logs.find((l) => l.operation === "delete");
    expect(update!.sql).toContain(`UPDATE "items" SET "name" = 'renamed'`);
    expect(remove!.sql).toContain(`DELETE FROM "items" WHERE "id" = 2`);
  });

  it("writes one entry per bulk delete, not one per row", async () => {
    const id = await createConnection();

    await webRequest(`/db/connections/${id}/rows/delete`, {
      method: "POST",
      body: JSON.stringify({ table: "items", pkColumn: "id", pkValues: [1, 2] }),
    });

    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.row_count).toBe(2);
    expect(JSON.parse(logs[0]!.params_json!).pkValues).toEqual([1, 2]);
  });

  it("records how many rows a partially failed bulk delete actually removed", async () => {
    const id = await createConnection();
    // Item 1 deletes cleanly, item 3 is referenced by a child row and fails.
    const res = await webRequest(`/db/connections/${id}/rows/delete`, {
      method: "POST",
      body: JSON.stringify({ table: "items", pkColumn: "id", pkValues: [1, 3] }),
    });
    expect(res.status).toBe(500);

    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("error");
    expect(logs[0]!.row_count).toBe(1);
    expect(logs[0]!.error).toContain("deleted 1 of 2 before failing");
  });

  it("records inserts with the executed statement", async () => {
    const id = await createConnection();

    const res = await webRequest(`/db/connections/${id}/row`, {
      method: "POST",
      body: JSON.stringify({ table: "items", values: { id: 4, name: "third" } }),
    });
    expect(res.status).toBe(201);

    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.operation).toBe("insert");
    expect(logs[0]!.sql).toContain("INSERT INTO");
    expect(logs[0]!.sql).toContain("'third'");
  });

  it("separates filter-generated SQL from statements the user typed", async () => {
    const id = await createConnection();

    await webRequest(`/db/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM items WHERE name LIKE '%first%'", source: "filter" }),
    });
    await webRequest(`/db/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM items" }),
    });

    const logs = listQueryLogs();
    expect(logs).toHaveLength(2);
    expect(logs.filter((l) => l.source === "filter")).toHaveLength(1);
    expect(logs.filter((l) => l.source === "editor")).toHaveLength(1);
  });

  it("does not log plain table browsing", async () => {
    const id = await createConnection();

    await app().request(`/db/connections/${id}/tables`);
    await app().request(`/db/connections/${id}/data?table=items`);

    expect(countQueryLogs()).toBe(0);
  });
});

describe("audit database setup", () => {
  it("enables incremental auto_vacuum so the size cap can reclaim disk", () => {
    const { auto_vacuum } = getAuditDb().query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
    expect(auto_vacuum).toBe(2);
  });

  it("keeps the user's query working when the audit write fails", async () => {
    const id = await createConnection();
    // Simulate a corrupt/unavailable audit store.
    getAuditDb().exec("DROP TABLE query_log");

    const res = await webRequest(`/db/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM items" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ppm-audit-error")).toContain("query_log");
  });
});
