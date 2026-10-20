/**
 * Opening a table tab for the PPM Assistant: the tab reads its first page as soon as it shows,
 * so a "table" that is really a view — whose code runs on that read, on a read-only connection
 * too — is opened only when `db_query`'s read proof holds for `SELECT * FROM <table>`; and the
 * first page such a tab loads is audited as the agent's, though the browser sent it.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { closeAuditDb, getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import { resolveOpenTabTarget, takeAssistantTableOpen } from "../../src/services/assistant-mcp/assistant-open-tab-target.ts";

const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;
let targetDbPath: string;
const project = { name: "api", path: tmpdir() };
// Connection names are unique across the whole run: later files in the same process share the database these rows land in.
const RUN = crypto.randomUUID().slice(0, 8);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-open-table-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
  initAdapters();
  setDb(openTestDb());
  getAuditDb();
  const dir = mkdtempSync(join(tmpdir(), "ppm-open-table-target-"));
  tempDirs.push(dir);
  targetDbPath = join(dir, "target.db");
  const db = new Database(targetDbPath);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, 'Apple'), (2, 'Pear');");
  db.close();
});

afterAll(() => {
  // Leave the next file in this process an empty database, not one holding these connections.
  setDb(openTestDb());
  closeAuditDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

/** A Postgres catalog's answer to the reach query, with `views` as given and nothing else. */
const reachAnswer = (views: Array<[string, string, string]>) => async () => [[JSON.stringify({
  views, policies: [], generated: [], domains: [], shadowed: [], types: [], columns: [], operators: [],
})]];

describe("opening a database table for the Assistant", () => {
  it("refuses a relation whose read PPM cannot prove has no other effect, on a read-only connection too", async () => {
    const conn = insertConnection("postgres", `pg-${RUN}`, { type: "postgres", connectionString: "postgres://u@127.0.0.1:1/x" });
    updateConnection(conn.id, { readonly: 1 });
    const catalogSeen: string[] = [];
    const evilView = reachAnswer([["public", "v", " SELECT pg_terminate_backend(42) AS x;"]]);
    const refused = await resolveOpenTabTarget(project, "database", { connectionId: conn.id, table: "v" }, () => async (sql) => {
      catalogSeen.push(sql);
      return evilView();
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("Not opened");
      expect(refused.error).toContain("db_query");
    }
    expect(catalogSeen.length).toBe(1);

    // A catalog that cannot be read proves nothing either.
    const unreadable = await resolveOpenTabTarget(project, "database", { connectionId: conn.id, table: "v" }, () => async () => {
      throw new Error("connection refused");
    });
    expect(unreadable.ok).toBe(false);
  });

  it("opens a plain table once the proof holds, and a connection with no table without any proof", async () => {
    const conn = insertConnection("postgres", `pg2-${RUN}`, { type: "postgres", connectionString: "postgres://u@127.0.0.1:1/x" });
    const opened = await resolveOpenTabTarget(project, "database", { connectionId: conn.id, schema: "public", table: "orders" }, () => reachAnswer([]));
    expect(opened).toEqual({ ok: true, value: { kind: "database", connectionId: conn.id, connectionName: `pg2-${RUN}`, dbType: "postgres", schema: "public", table: "orders" } });
    expect(takeAssistantTableOpen({ connectionId: conn.id, schema: "public", table: "orders" })).toBe(true);

    let asked = false;
    const bare = await resolveOpenTabTarget(project, "database", { connectionId: conn.id }, () => async () => { asked = true; return []; });
    expect(bare.ok).toBe(true);
    expect(asked).toBe(false);
  });
});

describe("the first page of a table tab the Assistant opened", () => {
  const app = () => new Hono().route("/db", databaseRoutes);
  const grid = (id: number) => app().request(`/db/connections/${id}/grid`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify({ table: "items" }),
  });

  it("is audited as the agent's, once; the user's own browsing stays unaudited", async () => {
    const conn = insertConnection("sqlite", `shop-${RUN}`, { type: "sqlite", path: targetDbPath });
    expect((await grid(conn.id)).status).toBe(200);
    expect(listQueryLogs()).toHaveLength(0);

    const opened = await resolveOpenTabTarget(project, "database", { connectionId: conn.id, table: "items" });
    expect(opened.ok).toBe(true);
    expect((await grid(conn.id)).status).toBe(200);
    const logs = listQueryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: "agent", source: "grid", status: "ok", connection_id: conn.id });
    expect(logs[0]!.sql).toContain('FROM "items"');

    // The next page is the user's scrolling, not the agent's read.
    expect((await grid(conn.id)).status).toBe(200);
    expect(listQueryLogs()).toHaveLength(1);
  });
});
