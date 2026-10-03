/**
 * A saved connection's pools are its own. Duplicate makes a second connection with the same
 * settings, and Disconnect, an edit or a deletion of one must not close the other's pools — that
 * would end a query, a Query tab's session or an import running on it. Through the real Postgres
 * adapter, with the services' methods recording the connection string each was given.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { _clearHeldLogins } from "../../../src/services/database/connection-login.ts";
import { _resetOpenedDatabases } from "../../../src/services/database/connection-database.ts";
import { postgresService, readonlyPostgresService } from "../../../src/services/postgres.service.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";

const app = new Hono().route("/db", databaseRoutes);
const services = [postgresService, readonlyPostgresService];
let opened: string[] = [];
let closed: string[] = [];
let restore: (() => void)[] = [];

beforeAll(() => initAdapters());

beforeEach(() => {
  setDb(openTestDb());
  _clearHeldLogins();
  _resetOpenedDatabases();
  opened = [];
  closed = [];
  for (const service of services) {
    const list = spyOn(service, "listObjects").mockImplementation(async (cs: string) => {
      opened.push(cs);
      return { schemas: ["public"], objects: [] };
    });
    const close = spyOn(service, "close").mockImplementation(async (cs: string) => {
      closed.push(cs);
    });
    restore.push(() => list.mockRestore(), () => close.mockRestore());
  }
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

/** A connection and its Duplicate, each with its own database and another one open. */
async function connectionAndCopy(): Promise<{ id: number; copy: number; pools: Record<"own" | "other" | "copyOwn" | "copyOther", string> }> {
  const connectionConfig = { type: "postgres", connectionString: "postgres://app:secret@127.0.0.1:5432/shop", singleDatabase: false };
  const created = await call("POST", "/db/connections", { type: "postgres", name: "app", connectionConfig });
  expect(created.status).toBe(201);
  const id: number = created.json.data.id;
  const duplicated = await call("POST", `/db/connections/${id}/duplicate`);
  expect(duplicated.status).toBe(201);
  const copy: number = duplicated.json.data.id;
  for (const path of [`${id}/objects`, `${id}/objects?database=reporting`, `${copy}/objects`, `${copy}/objects?database=reporting`]) {
    expect((await call("GET", `/db/connections/${path}`)).status).toBe(200);
  }
  const [own, other, copyOwn, copyOther] = opened as [string, string, string, string];
  return { id, copy, pools: { own, other, copyOwn, copyOther } };
}

describe("a Duplicate's pools", () => {
  it("are not the original's, for its own database or another", async () => {
    const { pools } = await connectionAndCopy();
    expect(new Set(Object.values(pools)).size).toBe(4);
  });

  for (const [what, act] of [
    ["Disconnect", (copy: number) => call("POST", `/db/connections/${copy}/disconnect`)],
    ["a deletion", (copy: number) => call("DELETE", `/db/connections/${copy}`)],
    ["an edit of its settings", (copy: number) => call("PUT", `/db/connections/${copy}`, {
      connectionConfig: { type: "postgres", connectionString: "postgres://app@127.0.0.1:5433/shop", singleDatabase: false, keepPassword: true },
    })],
  ] as const) {
    it(`are the only ones ${what} of the Duplicate closes`, async () => {
      const { copy, pools } = await connectionAndCopy();
      expect((await act(copy)).status).toBe(200);
      expect(closed).toContain(pools.copyOwn);
      expect(closed).toContain(pools.copyOther);
      expect(closed).not.toContain(pools.own);
      expect(closed).not.toContain(pools.other);
    });
  }

  it("are opened again under the same names, so Disconnect closes what the routes opened", async () => {
    const { id, pools } = await connectionAndCopy();
    expect((await call("GET", `/db/connections/${id}/objects`)).status).toBe(200);
    expect(opened.at(-1)).toBe(pools.own);
    expect((await call("POST", `/db/connections/${id}/disconnect`)).status).toBe(200);
    expect(closed).toContain(pools.own);
    expect(closed).toContain(pools.other);
  });
});
