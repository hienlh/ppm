/**
 * The tree's view of a server against real engines: its databases, another database reached with
 * `?database=` (objects, columns, rows, queries), and Disconnect closing the sessions every one of
 * them opened. Runs only when the URLs name disposable servers, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-explorer.test.ts
 *
 * The MySQL half needs the `mysql2` driver installed, as `database-mysql.test.ts` does it. Each run
 * creates databases named after itself and drops them at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import mysql2 from "mysql2/promise";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import type { GridResponse, QueryRunResponse } from "../../src/shared/db-grid.ts";
import type { DbColumnRef, DbObjectList } from "../../src/shared/db-structure.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
const MYSQL_ENGINES = [
  { type: "mysql" as const, url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb" as const, url: process.env.PPM_TEST_MARIADB_URL },
];
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

async function createConnection(type: string, connectionString: string): Promise<number> {
  const res = await call<{ id: number }>("POST", "/db/connections", {
    type, name: `${type}-explorer-${RUN}`, connectionConfig: { type, connectionString, singleDatabase: false },
  });
  expect(res.status).toBe(201);
  return res.data.id;
}

const withDb = (path: string, database: string) => `${path}${path.includes("?") ? "&" : "?"}database=${encodeURIComponent(database)}`;

async function eventually(check: () => Promise<boolean>, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

beforeAll(() => {
  initAdapters();
  setDb(openTestDb());
});

describe.skipIf(!PG_URL)("Postgres", () => {
  const OTHER = `ppm_ex_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  let id = 0;
  const sessionsOn = async (db: string) =>
    Number((await admin!`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${db} AND pid <> pg_backend_pid()`)[0]!.n);

  beforeAll(async () => {
    await admin!.unsafe(`CREATE DATABASE ${OTHER}`);
    const other = postgres(PG_URL!.replace(/\/[^/?]*(\?|$)/, `/${OTHER}$1`), { max: 1, onnotice: () => {} });
    await other.unsafe(`
      CREATE TABLE orders (id int PRIMARY KEY, total numeric(10, 2), note text);
      INSERT INTO orders VALUES (1, 9.50, 'a'), (2, 20, 'b');
      CREATE VIEW big_orders AS SELECT id FROM orders WHERE total > 10;
    `);
    await other.end();
    id = await createConnection("postgres", PG_URL!);
  });

  afterAll(async () => {
    await call("POST", `/db/connections/${id}/disconnect`);
    await admin!.unsafe(`DROP DATABASE IF EXISTS ${OTHER} WITH (FORCE)`);
    await admin!.end();
  });

  it("lists the server's databases, without templates", async () => {
    const { status, data } = await call<string[]>("GET", `/db/connections/${id}/databases`);
    expect(status).toBe(200);
    expect(data).toContain(OTHER);
    expect(data).toContain("postgres");
    expect(data).not.toContain("template0");
    expect(data).not.toContain("template1");
  });

  it("reads another database's objects, columns and rows, and runs a query in it", async () => {
    const own = await call<DbObjectList>("GET", `/db/connections/${id}/objects`);
    expect(own.data.objects.some((o) => o.name === "orders")).toBe(false);

    const objects = await call<DbObjectList>("GET", withDb(`/db/connections/${id}/objects`, OTHER));
    expect(objects.status).toBe(200);
    const mine = objects.data.objects.filter((o) => o.schema === "public");
    expect(mine.map((o) => `${o.kind}:${o.name}`).sort()).toEqual(["table:orders", "view:big_orders"]);

    const columns = await call<DbColumnRef[]>("GET", withDb(`/db/connections/${id}/columns`, OTHER));
    expect(columns.data.filter((c) => c.table === "orders")).toEqual([
      { schema: "public", table: "orders", name: "id", type: "integer" },
      { schema: "public", table: "orders", name: "total", type: "numeric(10,2)" },
      { schema: "public", table: "orders", name: "note", type: "text" },
    ]);
    expect(columns.data.filter((c) => c.table === "big_orders").map((c) => c.name)).toEqual(["id"]);

    const grid = await call<GridResponse>("POST", withDb(`/db/connections/${id}/grid`, OTHER), { table: "orders", sort: [{ column: "id", dir: "ASC" }] });
    expect(grid.status).toBe(200);
    expect(grid.data.rows.map((r) => r[2])).toEqual(["a", "b"]);

    const query = await call<QueryRunResponse>("POST", withDb(`/db/connections/${id}/query`, OTHER), { sql: "SELECT current_database() AS db" });
    expect(query.status).toBe(200);
    expect(query.data.rows).toEqual([[OTHER]]);
  });

  it("closes the sessions of every database it opened on Disconnect", async () => {
    await call("GET", withDb(`/db/connections/${id}/objects`, OTHER));
    expect(await sessionsOn(OTHER)).toBeGreaterThan(0);
    await call("POST", `/db/connections/${id}/disconnect`);
    expect(await eventually(async () => (await sessionsOn(OTHER)) === 0)).toBe(true);
  });
});

for (const engine of MYSQL_ENGINES) {
  describe.skipIf(!engine.url)(engine.type, () => {
    const A = `ppm_ex_a_${engine.type}_${RUN}`;
    const B = `ppm_ex_b_${engine.type}_${RUN}`;
    let admin: mysql2.Connection;
    let id = 0;

    beforeAll(async () => {
      await installDbDriver("mysql", { run: copyingRunner("mysql") });
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
      await admin.query(`
        CREATE DATABASE ${A}; CREATE DATABASE ${B};
        CREATE TABLE ${A}.customers (id INT PRIMARY KEY, name VARCHAR(40));
        CREATE TABLE ${B}.invoices (id INT PRIMARY KEY, amount DECIMAL(8,2), paid TINYINT(1));
        INSERT INTO ${B}.invoices VALUES (1, 5.00, 1), (2, 7.25, 0);
        CREATE VIEW ${B}.unpaid AS SELECT id FROM ${B}.invoices WHERE paid = 0;
      `);
      id = await createConnection(engine.type, `${engine.url!.replace(/\/$/, "")}/${A}`);
    });

    afterAll(async () => {
      await call("POST", `/db/connections/${id}/disconnect`);
      await admin?.query(`DROP DATABASE IF EXISTS ${A}; DROP DATABASE IF EXISTS ${B}`);
      await admin?.end();
    });

    it("lists the server's databases, without the system ones", async () => {
      const { status, data } = await call<string[]>("GET", `/db/connections/${id}/databases`);
      expect(status).toBe(200);
      expect(data).toContain(A);
      expect(data).toContain(B);
      for (const system of ["mysql", "sys", "information_schema", "performance_schema"]) expect(data).not.toContain(system);
    });

    it("scopes another database's objects and columns to it alone", async () => {
      const objects = await call<DbObjectList>("GET", withDb(`/db/connections/${id}/objects`, B));
      expect(objects.status).toBe(200);
      expect(objects.data.schemas).toEqual([B]);
      expect(objects.data.objects.map((o) => `${o.kind}:${o.name}`).sort()).toEqual(["table:invoices", "view:unpaid"]);

      const columns = await call<DbColumnRef[]>("GET", withDb(`/db/connections/${id}/columns`, B));
      expect(columns.data.filter((c) => c.table === "invoices")).toEqual([
        // As each catalog prints it: MySQL 8 dropped the display width MariaDB still shows.
        { schema: B, table: "invoices", name: "id", type: engine.type === "mariadb" ? "int(11)" : "int" },
        { schema: B, table: "invoices", name: "amount", type: "decimal(8,2)" },
        { schema: B, table: "invoices", name: "paid", type: "tinyint(1)" },
      ]);
      expect(columns.data.every((c) => c.schema === B)).toBe(true);
    });

    it("reads rows and runs a query in that database", async () => {
      const grid = await call<GridResponse>("POST", withDb(`/db/connections/${id}/grid`, B), { table: "invoices", schema: B, sort: [{ column: "id", dir: "ASC" }] });
      expect(grid.status).toBe(200);
      expect(grid.data.rows.map((r) => r[1])).toEqual(["5.00", "7.25"]);
      const query = await call<QueryRunResponse>("POST", withDb(`/db/connections/${id}/query`, B), { sql: "SELECT DATABASE() AS db" });
      expect(query.data.rows).toEqual([[B]]);
    });
  });
}
