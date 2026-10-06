/**
 * A connection that asks for its password: every route that opens it answers 428 until Database
 * Log In has given it a login, the login is held only while it works, and Disconnect, an edit or
 * a deletion lets go of it — closing the pools it opened, which hold the password too.
 *
 * The Postgres adapter is replaced by one that accepts a single password, so the whole round
 * trip runs without a server; `tests/integration/database-connection-login.test.ts` runs it
 * against real ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { getConnectionById, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { getAdapter, registerAdapter } from "../../../src/services/database/adapter-registry.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { _clearHeldLogins } from "../../../src/services/database/connection-login.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { DB_LOGIN_REQUIRED } from "../../../src/shared/db-connection-config.ts";
import type { DatabaseAdapter, DbConnectionConfig } from "../../../src/types/database.ts";

const RIGHT = "right-pa55word";
/** The fake server accepts any password that starts with RIGHT. */
const accepted = (url: string) => url.includes(`:${RIGHT}`);
const app = new Hono().route("/db", databaseRoutes);

/** What the fake server was asked to do, by the URL it was asked with. */
const calls = { probe: [] as string[], getTables: [] as string[], close: [] as string[] };

function refuse(): never {
  throw Object.assign(new Error('password authentication failed for user "app"'), { name: "PostgresError", code: "28P01" });
}

const fakePostgres = {
  async probe(config: DbConnectionConfig) {
    calls.probe.push(config.connectionString!);
    if (!accepted(config.connectionString!)) refuse();
    return { version: "PostgreSQL 99.1", databases: ["shop"] };
  },
  async getTables(config: DbConnectionConfig) {
    calls.getTables.push(config.connectionString!);
    if (!accepted(config.connectionString!)) refuse();
    return [{ name: "orders", schema: "public", rowCount: 3 }];
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
  for (const list of Object.values(calls)) list.length = 0;
});

/** Every response body, as text, so a test can say the password is in none of them. */
const seen: string[] = [];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, json: JSON.parse(text) };
}

async function askingConnection(passwordMode = "askPassword", connectionString = `postgres://app:${RIGHT}@db.example.com/shop`): Promise<number> {
  const { status, json } = await call("POST", "/db/connections", {
    type: "postgres", name: `prod-${passwordMode}`, connectionConfig: { type: "postgres", connectionString, passwordMode },
  });
  expect(status).toBe(201);
  return json.data.id;
}

const listed = async (id: number) => (await call("GET", "/db/connections")).json.data.find((c: { id: number }) => c.id === id);

describe("before a login", () => {
  it("answers 428 with what Database Log In needs, from every route that opens the connection", async () => {
    const id = await askingConnection();
    for (const [method, path, body] of [
      ["GET", `/db/connections/${id}/tables`],
      ["POST", `/db/connections/${id}/query`, { sql: "SELECT 1" }],
      ["POST", `/db/connections/${id}/grid`, { table: "orders", schema: "public", filters: [], sort: [], offset: 0, limit: 10 }],
      ["GET", `/db/connections/${id}/objects`],
      ["POST", `/db/connections/${id}/test`],
    ] as const) {
      const res = await call(method, path, body);
      expect({ path, status: res.status }).toEqual({ path, status: 428 });
      expect(res.json).toMatchObject({
        ok: false, code: DB_LOGIN_REQUIRED,
        login: { connectionId: id, name: "prod-askPassword", type: "postgres", user: "app", askUser: false },
      });
    }
    expect(calls.getTables).toEqual([]);
  });

  it("still lists, edits and shows the connection", async () => {
    const id = await askingConnection();
    expect((await call("GET", `/db/connections/${id}/tables?cached=1`)).status).toBe(200);
    expect((await call("GET", `/db/connections/${id}/config`)).json.data).toMatchObject({ passwordMode: "askPassword", hasPassword: false });
    expect(await listed(id)).toMatchObject({ password_mode: "askPassword", logged_in: false });
  });

  it("asks for the user too when the connection keeps no login at all", async () => {
    const id = await askingConnection("askUser");
    const res = await call("GET", `/db/connections/${id}/tables`);
    expect(res.json.login).toMatchObject({ user: "", askUser: true });
  });
});

describe("POST /db/connections/:id/login", () => {
  it("holds nothing when the login is refused, and says why in the driver's words", async () => {
    const id = await askingConnection();
    const { status, json } = await call("POST", `/db/connections/${id}/login`, { password: "wrong" });
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ ok: false, error: 'password authentication failed for user "app"' });
    expect(json.data.details).toContain("SQLSTATE 28P01 (invalid_password)");
    expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(428);
    expect(await listed(id)).toMatchObject({ logged_in: false });
  });

  it("holds a login that works, opens the connection with it, and never sends it back", async () => {
    seen.length = 0;
    const id = await askingConnection();
    const login = await call("POST", `/db/connections/${id}/login`, { user: "ignored", password: RIGHT });
    expect(login.json.data).toMatchObject({ ok: true, version: "PostgreSQL 99.1", databases: ["shop"] });

    const tables = await call("GET", `/db/connections/${id}/tables`);
    expect(tables).toMatchObject({ status: 200, json: { data: [{ name: "orders" }] } });
    // The saved user, not the one sent: a connection that asks for its password only takes that.
    expect(calls.getTables).toEqual([`postgres://app:${RIGHT}@db.example.com/shop`]);
    expect(await listed(id)).toMatchObject({ logged_in: true });
    await call("GET", `/db/connections/${id}/config`);
    for (const body of seen) expect(body).not.toContain(RIGHT);
  });

  it("takes the user as well when the connection asks for both", async () => {
    const id = await askingConnection("askUser", `postgres://someone:${RIGHT}@db.example.com/shop`);
    expect((await call("POST", `/db/connections/${id}/login`, { password: RIGHT })).json).toMatchObject({ ok: false, field: "user" });
    await call("POST", `/db/connections/${id}/login`, { user: "reader", password: RIGHT });
    await call("GET", `/db/connections/${id}/tables`);
    expect(calls.getTables).toEqual([`postgres://reader:${RIGHT}@db.example.com/shop`]);
  });

  it("is refused for a connection that saves its password", async () => {
    const { json } = await call("POST", "/db/connections", {
      type: "postgres", name: "saved", connectionConfig: { type: "postgres", connectionString: `postgres://app:${RIGHT}@h/shop` },
    });
    expect((await call("POST", `/db/connections/${json.data.id}/login`, { password: RIGHT })).status).toBe(400);
  });

  it("closes what a previous login opened when another one replaces it", async () => {
    const id = await askingConnection();
    await call("POST", `/db/connections/${id}/login`, { password: RIGHT });
    await call("POST", `/db/connections/${id}/login`, { password: RIGHT });
    expect(calls.close).toEqual([]);
    await call("POST", `/db/connections/${id}/login`, { password: `${RIGHT}-2` });
    expect(calls.close).toEqual([`postgres://app:${RIGHT}@db.example.com/shop`]);
  });
});

describe("letting go of a login", () => {
  async function loggedIn(): Promise<number> {
    const id = await askingConnection();
    await call("POST", `/db/connections/${id}/login`, { password: RIGHT });
    expect(await listed(id)).toMatchObject({ logged_in: true });
    return id;
  }

  it("Disconnect forgets it and closes the pools it opened", async () => {
    const id = await loggedIn();
    expect((await call("POST", `/db/connections/${id}/disconnect`)).json.data).toEqual({ disconnected: true });
    expect(calls.close).toEqual([`postgres://app:${RIGHT}@db.example.com/shop`]);
    expect(await listed(id)).toMatchObject({ logged_in: false });
    expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(428);
  });

  it("an edit to the config forgets it: the login was typed for the old one", async () => {
    const id = await loggedIn();
    await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "postgres", connectionString: "postgres://app@other-host/shop", passwordMode: "askPassword" } });
    expect(calls.close).toEqual([`postgres://app:${RIGHT}@db.example.com/shop`]);
    expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(428);
  });

  it("a rename keeps it", async () => {
    const id = await loggedIn();
    await call("PUT", `/db/connections/${id}`, { name: "renamed" });
    expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(200);
  });

  it("deleting the connection forgets it", async () => {
    const id = await loggedIn();
    await call("DELETE", `/db/connections/${id}`);
    expect(getConnectionById(id)).toBeNull();
    expect(calls.close).toEqual([`postgres://app:${RIGHT}@db.example.com/shop`]);
  });
});
