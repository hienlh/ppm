/**
 * The connection form's Advanced settings against real servers.
 *
 * - Default isolation level: Save's transaction runs at it, and the next transaction on the same
 *   pooled connection is back at the server's own. Each server reports the level of the
 *   transaction it is in — Postgres by `current_setting`, MySQL and MariaDB in `INNODB_TRX` — so
 *   a trigger records it while the changeset's INSERT runs. (`@@transaction_isolation` cannot:
 *   it shows the session's level, not the one `SET TRANSACTION` gave the next transaction.)
 * - "Use only database" unticked on a MySQL connection with a default database: the tree lists
 *   every database, while statements still run in the default one.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-connection-settings.test.ts
 *
 * Each run creates its own schema or databases and drops them at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import postgres from "postgres";
import mysql2 from "mysql2/promise";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { closeAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { postgresService } from "../../src/services/postgres.service.ts";
import { mysqlService } from "../../src/services/mysql.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PG_URL = process.env.PPM_TEST_PG_URL;
const MYSQL_ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

const app = new Hono().route("/db", databaseRoutes);
const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-it-connection-settings-"));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

/** A writable connection with `settings` beside its URL. */
async function connection(type: DbType, name: string, connectionString: string, settings: Record<string, unknown> = {}): Promise<number> {
  const res = await call("POST", "/db/connections", { type, name, readonly: false, connectionConfig: { type, connectionString, ...settings } });
  expect({ status: res.status, error: res.json.error }).toEqual({ status: 201, error: undefined });
  return res.json.data.id;
}

beforeAll(async () => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  setDb(openTestDb());
  initAdapters();
  if (MYSQL_ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  await postgresService.closeAll();
  await mysqlService.closeAll();
  // The query log is a file in `home` too, and Windows deletes no file that is open.
  closeAuditDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!PG_URL)("postgres: Default isolation level", () => {
  const S = `ppm_it_iso_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;

  beforeAll(async () => {
    await admin!.unsafe(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.items (id int PRIMARY KEY);
      CREATE TABLE ${S}.seen (level text);
      CREATE FUNCTION ${S}.record_level() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO ${S}.seen VALUES (current_setting('transaction_isolation')); RETURN NEW; END $$;
      CREATE TRIGGER record_level AFTER INSERT ON ${S}.items FOR EACH ROW EXECUTE FUNCTION ${S}.record_level();
    `);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin!.end();
  });

  it("runs Save at the connection's level, and at the server's own without one", async () => {
    const serializable = await connection("postgres", `pg-serializable-${RUN}`, PG_URL!, { isolationLevel: "SERIALIZABLE" });
    const plain = await connection("postgres", `pg-default-${RUN}`, PG_URL!);
    for (const [id, row] of [[serializable, 1], [plain, 2]] as const) {
      const res = await call("POST", `/db/connections/${id}/changeset/apply`, { schema: S, table: "items", inserts: [{ id: row }] });
      expect({ status: res.status, error: res.json.error }).toEqual({ status: 200, error: undefined });
    }
    expect((await admin!.unsafe(`SELECT level FROM ${S}.seen`)).map((r) => r.level)).toEqual(["serializable", "read committed"]);
  });
});

for (const engine of MYSQL_ENGINES) {
  describe.skipIf(!engine.url)(`${engine.type}: Default isolation level and Use only database`, () => {
    const A = `ppm_it_set_${engine.type}_${RUN}_a`;
    const B = `ppm_it_set_${engine.type}_${RUN}_b`;
    const base = engine.url?.replace(/\/$/, "") ?? "";
    let admin: mysql2.Connection;

    beforeAll(async () => {
      admin = await mysql2.createConnection({ uri: base.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
      await admin.query(`
        CREATE DATABASE ${A}; CREATE DATABASE ${B};
        CREATE TABLE ${A}.items (id INT PRIMARY KEY);
        CREATE TABLE ${A}.seen (level VARCHAR(40), thread BIGINT);
        CREATE TABLE ${B}.other (id INT PRIMARY KEY);
        CREATE TRIGGER ${A}.record_level AFTER INSERT ON ${A}.items FOR EACH ROW
          INSERT INTO ${A}.seen SELECT trx_isolation_level, trx_mysql_thread_id FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = CONNECTION_ID();
      `);
    });

    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${A}; DROP DATABASE IF EXISTS ${B};`);
      await admin.end();
    });

    it("runs Save at the connection's level, and at the server's own without one", async () => {
      const serializable = await connection(engine.type, `${engine.type}-serializable-${RUN}`, `${base}/${A}`, { isolationLevel: "SERIALIZABLE" });
      const plain = await connection(engine.type, `${engine.type}-default-${RUN}`, `${base}/${A}`);
      const writes: [number, string, unknown][] = [
        [serializable, "changeset/apply", { schema: A, table: "items", inserts: [{ id: 1 }] }],
        // The same connection's next transaction, typed in the editor rather than saved.
        [serializable, "query", { sql: `INSERT INTO ${A}.items VALUES (2)` }],
        [plain, "changeset/apply", { schema: A, table: "items", inserts: [{ id: 3 }] }],
      ];
      for (const [id, path, body] of writes) {
        const res = await call("POST", `/db/connections/${id}/${path}`, body);
        expect({ status: res.status, error: res.json.error }).toEqual({ status: 200, error: undefined });
        // INNODB_TRX is served from a cache refreshed at most every 100 ms: read sooner, it still
        // shows the transaction before.
        await Bun.sleep(250);
      }
      const [rows] = await admin.query(`SELECT level, thread FROM ${A}.seen`);
      const seen = rows as { level: string; thread: number }[];
      expect(seen.map((r) => r.level)).toEqual(["SERIALIZABLE", "REPEATABLE READ", "REPEATABLE READ"]);
      // A connection's pools are its own, so its next transaction ran on the session the
      // SERIALIZABLE Save had just used, and nothing of that level stayed behind on it.
      expect(seen[1]!.thread).toBe(seen[0]!.thread);
    });

    it("lists only the default database, unless Use only database is unticked", async () => {
      const only = await connection(engine.type, `${engine.type}-only-${RUN}`, `${base}/${A}`);
      const all = await connection(engine.type, `${engine.type}-all-${RUN}`, `${base}/${A}`, { singleDatabase: false });
      const schemas = async (id: number) => new Set(((await call("GET", `/db/connections/${id}/tables`)).json.data as { schema: string }[]).map((t) => t.schema));

      expect([...await schemas(only)]).toEqual([A]);
      const everything = await schemas(all);
      expect(everything.has(A) && everything.has(B)).toBe(true);
      // ...and a statement that names no database still runs in the default one.
      const query = await call("POST", `/db/connections/${all}/query`, { sql: "SELECT DATABASE() AS db" });
      expect(query.json.data.rows).toEqual([[A]]);
    });
  });
}
