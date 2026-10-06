/**
 * What the data grid's Save changes writes, on every engine PPM speaks: the script the dialog shows
 * is the script that runs, in DBGate's order — the ticked tables' DELETEs first, deepest first, then
 * INSERT, UPDATE, DELETE — all in one transaction, logged as the grid's. A database that refuses one
 * statement keeps every row as it was, the edits saved with it included.
 *
 * SQLite runs always. Postgres, MySQL and MariaDB run when their URLs name disposable servers, as in
 * `database-changeset-postgres.test.ts` and `database-mysql.test.ts`:
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-grid-save.test.ts
 *
 * Each run makes its own schema or database, named after the run, and drops it at the end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { readonlySqliteService, sqliteService } from "../../src/services/sqlite.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { ChangesetApplyResult, ChangesetFailure, ChangesetPreview } from "../../src/shared/db-changeset.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const app = () => new Hono().route("/db", databaseRoutes);

async function call<T>(path: string, body: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

/** A server's own handle on the test tables, outside PPM: what is really in them. */
interface Fixture {
  config: Record<string, unknown>;
  /** The schema the tables are in, as a changeset names it; none on SQLite. */
  schema?: string;
  /** Prefix that qualifies a table name in the fixture's own SQL. */
  prefix: string;
  exec: (sql: string) => Promise<void>;
  rows: (sql: string) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

interface Engine {
  type: DbType;
  url: string | undefined;
  open: () => Promise<Fixture>;
}

const ENGINES: Engine[] = [
  {
    // PPM turns SQLite's foreign keys on for every connection it opens (sqlite.service.ts).
    type: "sqlite", url: "always",
    open: async () => {
      const dir = mkdtempSync(join(tmpdir(), "ppm-grid-save-"));
      const path = join(dir, "shop.db");
      const db = new Database(path, { create: true });
      return {
        config: { type: "sqlite", path }, prefix: "",
        exec: async (sql) => { db.exec(sql); },
        rows: async (sql) => db.query(sql).all() as Record<string, unknown>[],
        close: async () => {
          db.close();
          // PPM's own handles too, which stay cached for minutes: Windows deletes no file one holds open.
          sqliteService.closeAll();
          readonlySqliteService.closeAll();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    type: "postgres", url: process.env.PPM_TEST_PG_URL,
    open: async () => {
      const schema = `ppm_gs_${RUN}`;
      const admin = postgres(process.env.PPM_TEST_PG_URL!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      return {
        config: { type: "postgres", connectionString: process.env.PPM_TEST_PG_URL }, schema, prefix: `${schema}.`,
        exec: async (sql) => { await admin.unsafe(sql); },
        rows: async (sql) => (await admin.unsafe(sql)) as unknown as Record<string, unknown>[],
        close: async () => { await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); },
      };
    },
  },
  ...(["mysql", "mariadb"] as const).map((type): Engine => {
    const url = type === "mysql" ? process.env.PPM_TEST_MYSQL_URL : process.env.PPM_TEST_MARIADB_URL;
    return {
      type, url,
      open: async () => {
        const db = `ppm_gs_${type}_${RUN}`;
        const admin = await mysql2.createConnection({ uri: url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
        await admin.query(`CREATE DATABASE ${db}; USE ${db};`);
        return {
          config: { type, connectionString: `${url!.replace(/\/$/, "")}/${db}` }, schema: db, prefix: "",
          exec: async (sql) => { await admin.query(sql); },
          rows: async (sql) => (await admin.query(sql))[0] as Record<string, unknown>[],
          close: async () => { await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); },
        };
      },
    };
  }),
];

beforeAll(async () => {
  initAdapters();
  setDb(openTestDb());
  if (process.env.PPM_TEST_MYSQL_URL || process.env.PPM_TEST_MARIADB_URL) {
    await installDbDriver("mysql", { run: copyingRunner("mysql") });
  }
});

afterAll(async () => {
  await postgresService.closeAll();
  await readonlyPostgresService.closeAll();
  await mysqlService.closeAll();
  await readonlyMysqlService.closeAll();
});

/** Each statement of a script as its verb and the table it writes, e.g. "DELETE order_items". */
const statements = (script: string) => script.split("\n").map((line) => {
  const m = /^(INSERT INTO|UPDATE|DELETE FROM)\s+((?:[`"]?\w+[`"]?\.)?[`"]?\w+[`"]?)/.exec(line);
  if (!m) throw new Error(`not a statement: ${line}`);
  return `${m[1]!.split(" ")[0]} ${m[2]!.replace(/[`"]/g, "").split(".").at(-1)}`;
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`Save changes on ${engine.type}`, () => {
    let fx: Fixture;
    let id = 0;
    const p = () => fx.prefix;
    const changeset = (body: object) => ({ ...(fx.schema ? { schema: fx.schema } : {}), ...body });
    const preview = (body: object) => call<ChangesetPreview>(`/db/connections/${id}/changeset/preview`, changeset(body));
    const apply = (body: object) => call<ChangesetApplyResult & ChangesetFailure>(`/db/connections/${id}/changeset/apply`, changeset(body));
    const users = () => fx.rows(`SELECT id, name FROM ${p()}users ORDER BY id`);
    const ids = async (table: string) => (await fx.rows(`SELECT id FROM ${p()}${table} ORDER BY id`)).map((r) => Number(r.id));
    const lastLog = () => listQueryLogs({ connectionId: id })[0];

    beforeAll(async () => {
      fx = await engine.open();
      await fx.exec(`
        CREATE TABLE ${p()}users (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL);
        CREATE TABLE ${p()}orders (id INT PRIMARY KEY, user_id INT, CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES ${p()}users (id));
        CREATE TABLE ${p()}order_items (id INT PRIMARY KEY, order_id INT, CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES ${p()}orders (id));
      `);
      id = insertConnection(engine.type, `${engine.type}-grid-save`, fx.config as never).id;
      updateConnection(id, { readonly: 0 });
    });

    beforeEach(async () => {
      await fx.exec(`
        DELETE FROM ${p()}order_items; DELETE FROM ${p()}orders; DELETE FROM ${p()}users;
        INSERT INTO ${p()}users VALUES (1, 'Ann'), (2, 'Bo'), (3, 'Cy'), (5, 'Ed');
        INSERT INTO ${p()}orders VALUES (10, 1), (11, 1), (20, 2);
        INSERT INTO ${p()}order_items VALUES (100, 10), (101, 11), (200, 20);
      `);
    });

    afterAll(async () => { await fx?.close(); });

    it("writes two edits, a new row and a deleted row as four statements: INSERT, UPDATE, UPDATE, DELETE", async () => {
      const body = {
        table: "users",
        inserts: [{ id: 4, name: "Dee" }],
        updates: [{ key: { id: 2 }, set: { name: "Bob" }, original: { name: "Bo" } }, { key: { id: 3 }, set: { name: "Cyd" }, original: { name: "Cy" } }],
        deletes: [{ key: { id: 5 } }],
      };
      const shown = await preview(body);
      expect(shown.status).toBe(200);
      expect(shown.data.statementCount).toBe(4);
      expect(statements(shown.data.script)).toEqual(["INSERT users", "UPDATE users", "UPDATE users", "DELETE users"]);
      // The tables that can point at users are offered whatever the row deleted has: this one has nothing, so nothing is ticked.
      expect(shown.data.references.map((r) => r.table)).toEqual(["order_items", "orders"]);

      const saved = await apply(body);
      expect(saved.status).toBe(200);
      expect(saved.data).toMatchObject({ inserted: 1, updated: 2, deleted: 1, cascaded: 0 });
      expect((await users()).map((r) => [Number(r.id), r.name])).toEqual([[1, "Ann"], [2, "Bob"], [3, "Cyd"], [4, "Dee"]]);
      expect(lastLog()).toMatchObject({ source: "grid", status: "ok", sql: shown.data.script });
    });

    it("lists the tables pointing at a deleted row down the whole chain, and deletes the ticked ones first, deepest first", async () => {
      const body = { table: "users", updates: [{ key: { id: 2 }, set: { name: "Bob" } }], deletes: [{ key: { id: 1 } }] };
      const shown = await preview(body);
      expect(shown.status).toBe(200);
      expect(shown.data.references.map((r) => [r.table, r.paths, r.cascadesInDb])).toEqual([
        ["order_items", [["order_items", "orders", "users"]], false],
        ["orders", [["orders", "users"]], false],
      ]);

      const saved = await apply({ ...body, cascade: [{ table: "order_items" }, { table: "orders" }] });
      expect(saved.status).toBe(200);
      expect(saved.data).toMatchObject({ updated: 1, deleted: 1, cascaded: 4 });
      expect((await users()).map((r) => [Number(r.id), r.name])).toEqual([[2, "Bob"], [3, "Cy"], [5, "Ed"]]);
      expect([await ids("orders"), await ids("order_items")]).toEqual([[20], [200]]);
      // What ran is what the dialog put together: the ticked tables' scripts, then the changes.
      const ran = lastLog()!;
      expect(ran).toMatchObject({ source: "grid", status: "ok" });
      expect(ran.sql).toBe([shown.data.references[0]!.script, shown.data.references[1]!.script, shown.data.script].join("\n"));
      expect(statements(ran.sql)).toEqual(["DELETE order_items", "DELETE orders", "UPDATE users", "DELETE users"]);
    });

    it("writes nothing when the database refuses to delete a row others point at, the edits with it included", async () => {
      const res = await apply({ table: "users", updates: [{ key: { id: 2 }, set: { name: "Bob" } }], deletes: [{ key: { id: 1 } }] });
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/^Statement 2 of 2 failed: .*foreign key.*\. Nothing was saved\./is);
      expect((await users()).map((r) => [Number(r.id), r.name])).toEqual([[1, "Ann"], [2, "Bo"], [3, "Cy"], [5, "Ed"]]);
      expect(await ids("orders")).toEqual([10, 11, 20]);
      expect(lastLog()).toMatchObject({ source: "grid", status: "error" });
    });
  });
}
