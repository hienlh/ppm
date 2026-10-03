/**
 * The routes behind the tree's database list: `GET /databases`, `?database=` reaching one of the
 * server's other databases, Disconnect closing the pools of every database opened, and the
 * connection menu's Duplicate and folder actions. The Postgres adapter is replaced by one that
 * records the URL each call was given.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getConnectionById, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { getAdapter, registerAdapter } from "../../../src/services/database/adapter-registry.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { _clearHeldLogins, hasHeldLogin, holdLogin } from "../../../src/services/database/connection-login.ts";
import { _resetOpenedDatabases } from "../../../src/services/database/connection-database.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { unloadDbDriver } from "../../../src/services/database/drivers/db-driver-loader.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import type { DatabaseAdapter, DbConnectionConfig } from "../../../src/types/database.ts";

const app = new Hono().route("/db", databaseRoutes);

const calls = { listDatabases: [] as string[], listObjects: [] as string[], listColumns: [] as string[], close: [] as string[] };

const fakePostgres = {
  async listDatabases(config: DbConnectionConfig) {
    calls.listDatabases.push(config.connectionString!);
    return ["reporting", "shop", "shop_staging"];
  },
  async listObjects(config: DbConnectionConfig) {
    calls.listObjects.push(config.connectionString!);
    return { schemas: ["public"], objects: [{ schema: "public", name: "orders", kind: "table" }] };
  },
  async listColumns(config: DbConnectionConfig) {
    calls.listColumns.push(config.connectionString!);
    return [{ schema: "public", table: "orders", name: "total", type: "numeric" }];
  },
  async close(config: DbConnectionConfig) {
    calls.close.push(config.connectionString!);
  },
} as unknown as DatabaseAdapter;

let realPostgres: DatabaseAdapter;
beforeAll(() => {
  initAdapters();
  realPostgres = getAdapter("postgres");
  registerAdapter("postgres", fakePostgres);
});
afterAll(() => registerAdapter("postgres", realPostgres));

beforeEach(() => {
  setDb(openTestDb());
  _clearHeldLogins();
  _resetOpenedDatabases();
  for (const list of Object.values(calls)) list.length = 0;
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function create(name: string, connectionConfig: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<number> {
  const type = connectionConfig.type;
  const { status, json } = await call("POST", "/db/connections", { type, name, connectionConfig, ...extra });
  expect(status).toBe(201);
  return json.data.id;
}

const server = (name = "app-dev", connectionString = "postgres://app:secret@db.example.com/shop", extra: Record<string, unknown> = {}) =>
  create(name, { type: "postgres", connectionString, ...extra });

/** A server connection the tree shows with the server's other databases under it. */
const serverOfMany = (name = "app-dev", extra: Record<string, unknown> = {}) => server(name, undefined, { singleDatabase: false, ...extra });

const listed = async (id: number) => (await call("GET", "/db/connections")).json.data.find((c: { id: number }) => c.id === id);

describe("the listing", () => {
  it("says whether the tree shows a connection as one database or as a server with a list", async () => {
    expect(await listed(await server("single"))).toMatchObject({ default_database: "shop", single_database: true });
    expect(await listed(await server("all", undefined, { singleDatabase: false }))).toMatchObject({ default_database: "shop", single_database: false });
    expect(await listed(await server("none", "postgres://app:secret@db.example.com"))).toMatchObject({ default_database: null, single_database: false });
    expect(await listed(await create("file", { type: "sqlite", path: "/tmp/ppm-listing.db" }))).toMatchObject({ default_database: null, single_database: true });
  });

  it("says where it connects and as whom, never with the password", async () => {
    const listing = await listed(await server());
    expect(listing).toMatchObject({ server: "db.example.com", user: "app" });
    expect(await listed(await server("port", "postgres://app:secret@db.example.com:6432/shop"))).toMatchObject({ server: "db.example.com:6432" });
    expect(await listed(await server("socket", "postgres://app:secret@/shop?host=%2Fvar%2Frun%2Fpostgresql"))).toMatchObject({ server: "/var/run/postgresql" });
    expect(await listed(await create("file", { type: "sqlite", path: "/tmp/ppm-where.db" }))).toMatchObject({ server: "/tmp/ppm-where.db", user: null });
    const body = JSON.stringify(listing);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("postgres://");
  });
});

describe("GET /connections/:id/databases", () => {
  it("lists the server's databases through the connection's own URL", async () => {
    const id = await server();
    const { status, json } = await call("GET", `/db/connections/${id}/databases`);
    expect(status).toBe(200);
    expect(json.data).toEqual(["reporting", "shop", "shop_staging"]);
    expect(calls.listDatabases).toEqual(["postgres://app:secret@db.example.com/shop"]);
  });
});

describe("GET /connections/:id/columns", () => {
  it("lists the columns of the database asked for", async () => {
    const id = await serverOfMany();
    const { status, json } = await call("GET", `/db/connections/${id}/columns?database=reporting`);
    expect(status).toBe(200);
    expect(json.data).toEqual([{ schema: "public", table: "orders", name: "total", type: "numeric" }]);
    expect(calls.listColumns).toEqual(["postgres://app:secret@db.example.com/reporting"]);
  });
});

describe("?database=", () => {
  it("reaches that database, and the connection's own without it", async () => {
    const id = await serverOfMany();
    expect((await call("GET", `/db/connections/${id}/objects?database=reporting`)).status).toBe(200);
    expect((await call("GET", `/db/connections/${id}/objects`)).status).toBe(200);
    expect(calls.listObjects).toEqual([
      "postgres://app:secret@db.example.com/reporting",
      "postgres://app:secret@db.example.com/shop",
    ]);
  });

  it("answers 400 for a name no server can have, and for a SQLite file", async () => {
    const id = await server();
    const tooLong = await call("GET", `/db/connections/${id}/objects?database=${"x".repeat(300)}`);
    expect(tooLong.status).toBe(400);
    const nul = await call("GET", `/db/connections/${id}/objects?database=a%00b`);
    expect(nul.status).toBe(400);
    const file = await create("file", { type: "sqlite", path: "/tmp/ppm-target.db" });
    const sqlite = await call("GET", `/db/connections/${file}/objects?database=main`);
    expect(sqlite).toMatchObject({ status: 400, json: { error: "A SQLite connection is a single database." } });
    expect(calls.listObjects).toEqual([]);
  });

  /** Every route the tree reaches another database through: the 400 comes before the route runs. */
  const ROUTES: [string, string, unknown?][] = [
    ["GET", "objects"], ["GET", "columns"], ["GET", "schema?table=orders"], ["GET", "structure?table=orders"],
    ["POST", "grid", { table: "orders" }], ["POST", "query/script", { sql: "SELECT 1" }], ["POST", "impexp/export", {}],
  ];
  const at = (path: string, database: string) => `${path}${path.includes("?") ? "&" : "?"}database=${encodeURIComponent(database)}`;

  it("answers 400 for another database of a connection that uses only its own", async () => {
    const id = await server();
    for (const [method, path, body] of ROUTES) {
      expect(await call(method, `/db/connections/${id}/${at(path, "reporting")}`, body))
        .toMatchObject({ status: 400, json: { error: 'This connection uses only database "shop".' } });
    }
    expect((await call("GET", `/db/connections/${id}/objects?database=shop`)).status).toBe(200);
    expect(calls.listObjects).toEqual(["postgres://app:secret@db.example.com/shop"]);
  });

  it("answers 400 for a database outside the allowed list, by name ignoring case, and never for the connection's own", async () => {
    // The regular expression is the tree's filter only: a pattern is the user's own text, and one
    // that backtracks catastrophically would stall the server.
    const id = await serverOfMany("listed", { allowedDatabases: ["Reporting"], allowedDatabasesRegex: "^nothing$" });
    for (const [method, path, body] of ROUTES) {
      expect(await call(method, `/db/connections/${id}/${at(path, "shop_staging")}`, body))
        .toMatchObject({ status: 400, json: { error: '"shop_staging" is not one of this connection\'s allowed databases.' } });
    }
    expect((await call("GET", `/db/connections/${id}/objects?database=reporting`)).status).toBe(200);
    expect((await call("GET", `/db/connections/${id}/objects?database=shop`)).status).toBe(200);
    expect(calls.listObjects).toEqual(["postgres://app:secret@db.example.com/reporting", "postgres://app:secret@db.example.com/shop"]);
  });
});

describe("Disconnect", () => {
  it("closes the pools of every database opened, and forgets them", async () => {
    const id = await serverOfMany();
    await call("GET", `/db/connections/${id}/objects?database=reporting`);
    await call("GET", `/db/connections/${id}/objects?database=shop_staging`);
    await call("GET", `/db/connections/${id}/objects?database=shop`);
    await call("POST", `/db/connections/${id}/disconnect`);
    expect(calls.close.sort()).toEqual([
      "postgres://app:secret@db.example.com/reporting",
      "postgres://app:secret@db.example.com/shop",
      "postgres://app:secret@db.example.com/shop_staging",
    ]);
    calls.close.length = 0;
    await call("POST", `/db/connections/${id}/disconnect`);
    expect(calls.close).toEqual(["postgres://app:secret@db.example.com/shop"]);
  });

  it("keeps a held login when it is a reconnect, and forgets it otherwise", async () => {
    const id = await create("asks", { type: "postgres", connectionString: "postgres://app@db.example.com/shop", passwordMode: "askPassword", singleDatabase: false });
    await holdLogin(getConnectionById(id)!, { password: "lent" });
    await call("GET", `/db/connections/${id}/objects?database=reporting`);

    await call("POST", `/db/connections/${id}/disconnect`, { keepLogin: true });
    expect(hasHeldLogin(id)).toBe(true);
    expect(calls.close.sort()).toEqual(["postgres://app:lent@db.example.com/reporting", "postgres://app:lent@db.example.com/shop"]);

    await call("POST", `/db/connections/${id}/disconnect`);
    expect(hasHeldLogin(id)).toBe(false);
  });

  it("happens on a delete too", async () => {
    const id = await serverOfMany();
    await call("GET", `/db/connections/${id}/objects?database=reporting`);
    await call("DELETE", `/db/connections/${id}`);
    expect(calls.close.sort()).toEqual(["postgres://app:secret@db.example.com/reporting", "postgres://app:secret@db.example.com/shop"]);
  });
});

describe("POST /connections/:id/duplicate", () => {
  it("copies every setting, the saved password included, under a free name", async () => {
    const id = await server("app-dev", undefined, { singleDatabase: false });
    await call("PUT", `/db/connections/${id}`, { groupName: "Local", color: "#3b82f6", readonly: 0, aiAccess: 0 });
    const first = await call("POST", `/db/connections/${id}/duplicate`);
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ name: "app-dev (copy)", group_name: "Local", color: "#3b82f6", readonly: 0, ai_access: 0 });
    const second = await call("POST", `/db/connections/${id}/duplicate`);
    expect(second.json.data.name).toBe("app-dev (copy 2)");
    const config = (await call("GET", `/db/connections/${first.json.data.id}/config`)).json.data;
    expect(config).toMatchObject({ connectionString: "postgres://app@db.example.com/shop", hasPassword: true, singleDatabase: false });
    expect(JSON.stringify(first.json)).not.toContain("secret");
  });

  describe("with no driver installed", () => {
    // The loader keeps a driver for the life of the process, and a file run before this one can
    // leave it installed in the run's PPM dir: the connection would then reach for a real server.
    const originalPpmHome = process.env.PPM_HOME;
    let dir = "";
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "ppm-db-duplicate-"));
      process.env.PPM_HOME = dir;
      _resetPpmDir();
      await unloadDbDriver("mysql");
    });
    afterEach(() => {
      if (originalPpmHome === undefined) delete process.env.PPM_HOME;
      else process.env.PPM_HOME = originalPpmHome;
      _resetPpmDir();
      rmSync(dir, { recursive: true, force: true });
    });

    it("needs no driver, as editing does not", async () => {
      const id = await create("maria", { type: "mariadb", connectionString: "mariadb://root:pw@db/shop" });
      expect((await call("GET", `/db/connections/${id}/objects`)).status).toBe(424);
      expect((await call("POST", `/db/connections/${id}/duplicate`)).status).toBe(201);
    });
  });
});

describe("POST /connections/folder", () => {
  it("renames a folder by moving its connections, and deletes one by moving them out", async () => {
    const a = await server("a");
    const b = await server("b");
    const c = await server("c");
    await call("PUT", `/db/connections/${a}`, { groupName: "Local" });
    await call("PUT", `/db/connections/${b}`, { groupName: "Local" });
    await call("PUT", `/db/connections/${c}`, { groupName: "Production" });

    expect((await call("POST", "/db/connections/folder", { from: "Local", to: "  Dev  " })).json.data).toEqual({ moved: 2 });
    expect([(await listed(a)).group_name, (await listed(b)).group_name, (await listed(c)).group_name]).toEqual(["Dev", "Dev", "Production"]);

    expect((await call("POST", "/db/connections/folder", { from: "Dev", to: null })).json.data).toEqual({ moved: 2 });
    expect([(await listed(a)).group_name, (await listed(b)).group_name]).toEqual([null, null]);
  });

  it("refuses a blank or overlong name", async () => {
    expect((await call("POST", "/db/connections/folder", { from: "Local", to: "   " })).status).toBe(400);
    expect((await call("POST", "/db/connections/folder", { from: "Local", to: "x".repeat(101) })).status).toBe(400);
    expect((await call("POST", "/db/connections/folder", { to: "Dev" })).status).toBe(400);
  });
});
