/**
 * The routes behind the connection form: create and edit, `/config` for the edit form, and
 * `/test` for a config nobody has saved. Pinned here: no response ever carries a password, a
 * password left empty on edit is kept, a connection that asks for its password stores none, and
 * a test says what happened in the driver's words.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { decryptConfig, getConnectionById, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { DB_LOGIN_REQUIRED } from "../../../src/shared/db-connection-config.ts";

const SECRET = "hunter2-s3cret";
const originalPpmHome = process.env.PPM_HOME;
const temps: string[] = [];
const app = new Hono().route("/db", databaseRoutes);

initAdapters();

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-db-form-routes-"));
  temps.push(dir);
  process.env.PPM_HOME = dir;
  _resetPpmDir();
  setDb(openTestDb());
});

afterEach(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Every response body, as text, so a test can say a secret is in none of them. */
const seen: string[] = [];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, json: JSON.parse(text) };
}

async function create(body: Record<string, unknown>): Promise<number> {
  const { status, json } = await call("POST", "/db/connections", body);
  expect({ status, error: json.error }).toEqual({ status: 201, error: undefined });
  return json.data.id;
}

const stored = (id: number) => decryptConfig(getConnectionById(id)!.connection_config);

describe("creating and editing a connection", () => {
  it("never sends a password back, from any route the form uses", async () => {
    seen.length = 0;
    const id = await create({
      type: "postgres", name: "shop", connectionConfig: { type: "postgres", connectionString: `postgres://app:${SECRET}@db.example.com/shop` },
    });
    await call("GET", "/db/connections");
    await call("GET", `/db/connections/${id}`);
    const config = await call("GET", `/db/connections/${id}/config`);
    await call("PUT", `/db/connections/${id}`, { name: "shop-2", connectionConfig: { type: "postgres", connectionString: "postgres://app@db.example.com/shop", keepPassword: true } });
    await call("POST", "/db/test", { type: "postgres", connectionId: id, connectionConfig: { type: "postgres", connectionString: "postgres://app@127.0.0.1:1/shop", keepPassword: true } });

    expect(config.json.data).toEqual({ type: "postgres", connectionString: "postgres://app@db.example.com/shop", hasPassword: true });
    for (const body of seen) expect(body).not.toContain(SECRET);
    // ...while the password is still there to connect with.
    expect(stored(id)).toMatchObject({ connectionString: `postgres://app:${SECRET}@db.example.com/shop` });
  });

  it("keeps the saved password for an empty field, and changes it for a typed one", async () => {
    const id = await create({ type: "mysql", name: "crm", connectionConfig: { type: "mysql", connectionString: `mysql://root:${SECRET}@h/crm` } });
    await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "mysql", connectionString: "mysql://root@h:3307/crm", keepPassword: true } });
    expect(stored(id)).toMatchObject({ connectionString: `mysql://root:${SECRET}@h:3307/crm` });
    await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "mysql", connectionString: "mysql://root:new@h:3307/crm", keepPassword: true } });
    expect(stored(id)).toMatchObject({ connectionString: "mysql://root:new@h:3307/crm" });
  });

  it("stores no password for a connection that asks for one", async () => {
    const id = await create({
      type: "postgres", name: "prod",
      connectionConfig: { type: "postgres", connectionString: `postgres://app:${SECRET}@prod/shop`, passwordMode: "askPassword" },
    });
    expect(stored(id)).toEqual({ type: "postgres", connectionString: "postgres://app@prod/shop", passwordMode: "askPassword" });
    expect(getConnectionById(id)!.connection_config).not.toContain(SECRET);
  });

  it("stores what the form sets beside the URL, and keeps the URL when only those change", async () => {
    const id = await create({ type: "mariadb", name: "maria", connectionConfig: { type: "mariadb", connectionString: `mariadb://root:${SECRET}@h/shop` } });
    await call("PUT", `/db/connections/${id}`, {
      connectionConfig: { type: "mariadb", entry: "fields", allowedDatabasesRegex: "^shop", isolationLevel: "READ COMMITTED", singleDatabase: false },
    });
    expect(stored(id)).toEqual({
      type: "mariadb", connectionString: `mariadb://root:${SECRET}@h/shop`,
      entry: "fields", allowedDatabasesRegex: "^shop", isolationLevel: "READ COMMITTED", singleDatabase: false,
    });
  });

  it("takes Is read only from the form, and is readonly when it says nothing", async () => {
    const writable = await create({ type: "sqlite", name: "w", readonly: false, connectionConfig: { type: "sqlite", path: "/tmp/w.db" } });
    const plain = await create({ type: "sqlite", name: "r", connectionConfig: { type: "sqlite", path: "/tmp/r.db" } });
    expect(getConnectionById(writable)!.readonly).toBe(0);
    expect(getConnectionById(plain)!.readonly).toBe(1);
  });

  it("refuses a name another connection has, naming the field", async () => {
    await create({ type: "sqlite", name: "one", connectionConfig: { type: "sqlite", path: "/tmp/1.db" } });
    const two = await create({ type: "sqlite", name: "two", connectionConfig: { type: "sqlite", path: "/tmp/2.db" } });
    const dup = await call("POST", "/db/connections", { type: "sqlite", name: " one ", connectionConfig: { type: "sqlite", path: "/tmp/3.db" } });
    expect(dup).toMatchObject({ status: 409, json: { ok: false, field: "name", error: 'A connection named "one" already exists' } });
    expect((await call("PUT", `/db/connections/${two}`, { name: "one" })).status).toBe(409);
    // Its own name is not taken.
    expect((await call("PUT", `/db/connections/${two}`, { name: "two" })).status).toBe(200);
  });

  it("answers 400 naming the field for a config the form should not have sent", async () => {
    const bad = await call("POST", "/db/connections", {
      type: "postgres", name: "x", connectionConfig: { type: "postgres", connectionString: "postgres://h/db", allowedDatabasesRegex: "([" },
    });
    expect(bad).toMatchObject({ status: 400, json: { ok: false, field: "allowedDatabasesRegex" } });
    const wrongEngine = await call("POST", "/db/connections", { type: "postgres", name: "y", connectionConfig: { type: "postgres", connectionString: "mysql://h/db" } });
    expect(wrongEngine).toMatchObject({ status: 400, json: { field: "connectionString" } });
  });
});

describe("POST /db/test", () => {
  it("tests a SQLite file nobody has saved", async () => {
    const file = join(temps.at(-1)!, "app.db");
    const db = new Database(file);
    db.exec("CREATE TABLE t (id INTEGER)");
    db.close();
    const { status, json } = await call("POST", "/db/test", { type: "sqlite", connectionConfig: { type: "sqlite", path: file } });
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ ok: true, version: expect.stringMatching(/^SQLite /), databases: [], target: file });
  });

  it("answers a failed test with the driver's words and the details", async () => {
    const { status, json } = await call("POST", "/db/test", {
      type: "postgres", connectionConfig: { type: "postgres", connectionString: `postgres://app:${SECRET}@127.0.0.1:1/shop` },
    });
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ ok: false, error: expect.stringContaining("ECONNREFUSED"), elapsedMs: expect.any(Number) });
    expect(json.data.details).toContain("Checked from the PPM host");
  });

  it("asks for a login before testing a connection that asks for its password", async () => {
    const id = await create({
      type: "postgres", name: "prod", connectionConfig: { type: "postgres", connectionString: "postgres://app@127.0.0.1:1/shop", passwordMode: "askPassword" },
    });
    const config = { type: "postgres", connectionString: "postgres://app@127.0.0.1:1/shop", passwordMode: "askPassword" };
    const ask = await call("POST", "/db/test", { type: "postgres", connectionId: id, connectionConfig: config });
    expect(ask).toMatchObject({
      status: 428,
      json: { ok: false, code: DB_LOGIN_REQUIRED, login: { connectionId: id, name: "prod", type: "postgres", user: "app", askUser: false } },
    });
    // With the login it goes ahead (and fails on the closed port, which is the point: it tried).
    const tried = await call("POST", "/db/test", { type: "postgres", connectionId: id, connectionConfig: config, login: { password: SECRET } });
    expect(tried).toMatchObject({ status: 200, json: { data: { ok: false } } });
    expect(JSON.stringify(tried.json)).not.toContain(SECRET);
  });

  it("refuses to test one saved connection as another engine", async () => {
    const id = await create({ type: "sqlite", name: "file", connectionConfig: { type: "sqlite", path: "/tmp/f.db" } });
    const res = await call("POST", "/db/test", { type: "postgres", connectionId: id, connectionConfig: { type: "postgres", connectionString: "postgres://h/db" } });
    expect(res).toMatchObject({ status: 400, json: { field: "type" } });
    expect((await call("POST", "/db/test", { type: "sqlite", connectionId: 9999, connectionConfig: { type: "sqlite", path: "/x" } })).status).toBe(404);
  });
});

describe("GET /db/connections/:id/config", () => {
  it("sends no URL for a saved string PPM cannot read, rather than one with the password in it", async () => {
    // Written the way `ppm db add` or an import could have stored it.
    const { insertConnection } = await import("../../../src/services/db.service.ts");
    const conn = insertConnection("postgres", "odd", { type: "postgres", connectionString: `postgres://u:${SECRET}@h:1:2/db` });
    const { json } = await call("GET", `/db/connections/${conn.id}/config`);
    expect(json.data).toEqual({ type: "postgres", connectionString: null, hasPassword: false });
  });

  it("is 404 for a connection that does not exist", async () => {
    expect((await call("GET", "/db/connections/424242/config")).status).toBe(404);
  });
});

describe("Available to the AI chat", () => {
  const sqlite = (name: string, extra: Record<string, unknown> = {}) =>
    create({ type: "sqlite", name, connectionConfig: { type: "sqlite", path: "/data/app.db" }, ...extra });
  const aiAccess = (id: number) => getConnectionById(id)!.ai_access;

  it("is on unless the form unticked it, and an edit changes only what it sends", async () => {
    const on = await sqlite("on");
    const off = await sqlite("off", { aiAccess: false });
    expect([aiAccess(on), aiAccess(off)]).toEqual([1, 0]);

    await call("PUT", `/db/connections/${off}`, { name: "renamed" });
    expect(aiAccess(off)).toBe(0);
    await call("PUT", `/db/connections/${off}`, { aiAccess: true });
    expect(aiAccess(off)).toBe(1);
    await call("PUT", `/db/connections/${on}`, { aiAccess: 0 });
    expect(aiAccess(on)).toBe(0);
  });

  it("is in the listing, and survives an export and an import", async () => {
    const off = await sqlite("private", { aiAccess: false });
    expect((await call("GET", "/db/connections")).json.data.find((c: { id: number }) => c.id === off))
      .toMatchObject({ ai_access: 0 });

    const exported = (await call("GET", "/db/connections/export")).json.data.connections;
    expect(exported[0]).toMatchObject({ name: "private", ai_access: 0 });
    const imported = (await call("POST", "/db/connections/import", { connections: exported })).json.data.connections;
    expect(aiAccess(imported[0].id)).toBe(0);
  });
});
