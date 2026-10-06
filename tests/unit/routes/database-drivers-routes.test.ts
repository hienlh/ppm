/**
 * `/api/db/drivers`, and the 424 a connection answers while its driver is not installed.
 *
 * Nothing here installs, so it needs neither the network nor a MySQL server. What is pinned is
 * what the browser draws its Install button from — status 424, `code`, and the driver's id and
 * name — that only ids from the catalog are accepted, and that a connection's own record stays
 * editable without the driver.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { unloadDbDriver } from "../../../src/services/database/drivers/db-driver-loader.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { readonlySqliteService, sqliteService } from "../../../src/services/sqlite.service.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { DB_DRIVER_MISSING } from "../../../src/shared/db-drivers.ts";

const originalPpmHome = process.env.PPM_HOME;
const temps: string[] = [];
const app = new Hono().route("/db", databaseRoutes);

initAdapters();

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-db-driver-routes-"));
  temps.push(dir);
  process.env.PPM_HOME = dir;
  _resetPpmDir();
  // The loader keeps a driver for the life of the process; this directory has none.
  await unloadDbDriver("mysql");
  setDb(openTestDb());
});

afterEach(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

afterAll(() => {
  // The SQLite file a connection read stays open in PPM's cache, and Windows deletes no file that is open.
  sqliteService.closeAll();
  readonlySqliteService.closeAll();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function addConnection(type: string, connectionConfig: Record<string, string>): Promise<number> {
  const { status, json } = await call("POST", "/db/connections", { type, name: `${type}-${temps.length}`, connectionConfig });
  expect(status).toBe(201);
  return json.data.id;
}

describe("GET /db/drivers", () => {
  it("lists every driver as missing, with what an install would fetch", async () => {
    const { status, json } = await call("GET", "/db/drivers");
    expect(status).toBe(200);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "mysql", displayName: "MySQL / MariaDB", engines: ["mysql", "mariadb"], usedFor: "MySQL and MariaDB connections",
        package: "mysql2", version: "3.24.4", license: "MIT",
        state: "missing", installed: null, installing: false, removing: false,
      }),
      expect.objectContaining({
        id: "ssh", displayName: "SSH tunnel", engines: [], usedFor: "connections through an SSH tunnel",
        package: "ssh2", version: "1.17.0", license: "MIT",
        state: "missing", installed: null, installing: false, removing: false,
      }),
    ]);
  });
});

describe("install and remove", () => {
  it("refuses an id that is not in the catalog", async () => {
    for (const [method, path] of [["POST", "/db/drivers/oracle/install"], ["DELETE", "/db/drivers/pg"]] as const) {
      const { status, json } = await call(method, path);
      expect(status).toBe(404);
      expect(json.error).toStartWith("Unknown database driver:");
    }
  });

  it("removing a driver that is not installed is not an error", async () => {
    const { status, json } = await call("DELETE", "/db/drivers/mysql");
    expect(status).toBe(200);
    expect(json.data.state).toBe("missing");
  });
});

describe("a connection whose driver is missing", () => {
  const expectMissing = ({ status, json }: { status: number; json: any }) => {
    expect(status).toBe(424);
    expect(json).toMatchObject({
      ok: false, code: DB_DRIVER_MISSING, driver: { id: "mysql", displayName: "MySQL / MariaDB" },
    });
    expect(json.error).toContain("Settings → Database Drivers");
  };

  it("answers 424 naming the driver, wherever the database is needed", async () => {
    const id = await addConnection("mysql", { type: "mysql", connectionString: "mysql://u:p@127.0.0.1:1/db" });
    expectMissing(await call("POST", `/db/connections/${id}/grid`, { table: "t", schema: "db", filters: [], sort: [], offset: 0, limit: 10 }));
    expectMissing(await call("GET", `/db/connections/${id}/tables`));
    expectMissing(await call("POST", `/db/connections/${id}/query`, { sql: "SELECT 1" }));
    expectMissing(await call("POST", `/db/connections/${id}/test`));
    expectMissing(await call("POST", "/db/test", { type: "mariadb", connectionConfig: { type: "mariadb", connectionString: "mariadb://u@h/db" } }));
  });

  it("still lists its cached tables and can be edited or deleted", async () => {
    const id = await addConnection("mariadb", { type: "mariadb", connectionString: "mariadb://u:p@127.0.0.1:1/db" });
    expect((await call("GET", `/db/connections/${id}/tables?cached=1`)).status).toBe(200);
    expect((await call("PUT", `/db/connections/${id}`, { name: "renamed" })).json.data.name).toBe("renamed");
    expect((await call("GET", `/db/connections/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/db/connections/${id}`)).status).toBe(200);
  });

  it("leaves built-in engines alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-db-driver-routes-sqlite-"));
    temps.push(dir);
    const file = join(dir, "a.db");
    const db = new Database(file);
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
    db.close();
    const id = await addConnection("sqlite", { type: "sqlite", path: file });
    const { status, json } = await call("GET", `/db/connections/${id}/tables`);
    expect(status).toBe(200);
    expect(json.data.map((t: { name: string }) => t.name)).toEqual(["notes"]);
  });
});
