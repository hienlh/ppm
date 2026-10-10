/**
 * An approved UPDATE or DELETE from the Assistant answers with the rows it changed as they were,
 * read by a SELECT of the same table and WHERE inside the write's own transaction, against real
 * Postgres, MySQL and MariaDB servers: the old values come back, the change lands, a write that
 * fails takes the read's transaction back with it and leaves nothing open. Runs for each URL
 * given, e.g.
 *
 *   docker run --rm -d -p 25433:5432 -e POSTGRES_PASSWORD=x postgres:15
 *   docker run --rm -d -p 53307:3306 -e MYSQL_ROOT_PASSWORD=x mysql:8.4
 *   docker run --rm -d -p 53308:3306 -e MARIADB_ROOT_PASSWORD=x mariadb:11
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25433/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:53307 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:53308 \
 *     bun test tests/integration/assistant-write-old-rows.test.ts
 *
 * Everything it creates lives in one schema (Postgres) or database (MySQL/MariaDB) named after
 * this run, dropped at the end.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConnectionById, insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { connConfig } from "../../src/server/routes/database-route-helpers.ts";
import { dbQuery } from "../../src/services/assistant-mcp/assistant-db-tools.ts";
import type { AskApproval } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { DbQuerySession } from "../../src/types/database.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const ENGINES: { type: Exclude<DbType, "sqlite">; url: string | undefined; begin: string }[] = [
  { type: "postgres", url: process.env.PPM_TEST_PG_URL, begin: "BEGIN" },
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL, begin: "START TRANSACTION" },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL, begin: "START TRANSACTION" },
];
const RUN = `ppm_old_rows_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const CALLER = { actor: "agent" as const, callerIp: null, callerUa: "PPM Assistant (integration test)" };
const APPROVE: AskApproval = async () => ({ verdict: "approved" });
const body = (r: Record<string, unknown>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;

const home = mkdtempSync(join(tmpdir(), "ppm-old-rows-it-"));
const originalPpmHome = process.env.PPM_HOME;

beforeAll(async () => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  setDb(openTestDb());
  initAdapters();
  if (ENGINES.some((e) => e.url && e.type !== "postgres")) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  for (const e of ENGINES) {
    if (!e.url) continue;
    const services = e.type === "postgres" ? [postgresService, readonlyPostgresService] : [mysqlService, readonlyMysqlService];
    for (const s of services) await s.close(e.url).catch(() => {});
  }
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* a driver file still held on Windows */ }
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`${engine.type}: an approved UPDATE or DELETE`, () => {
    const url = engine.url!;
    const table = `${RUN}.items`;
    let id = 0;
    const spies: Array<{ mockRestore(): void }> = [];
    const admin = (sql: string) => getAdapter(engine.type).runQuery(connConfig(getConnectionById(id)!), sql);
    const qty = async (rowId: number) => (await admin(`SELECT qty FROM ${table} WHERE id = ${rowId}`)).rows[0]?.[0];

    beforeAll(async () => {
      id = insertConnection(engine.type, `${engine.type}-old-rows`, { type: engine.type, connectionString: url }).id;
      updateConnection(id, { readonly: 0 });
      await admin(engine.type === "postgres" ? `CREATE SCHEMA ${RUN}` : `CREATE DATABASE ${RUN}`);
      await admin(`CREATE TABLE ${table} (id int PRIMARY KEY, name varchar(20) NOT NULL, qty int)`);
      await admin(`INSERT INTO ${table} (id, name, qty) VALUES (1, 'apples', 3), (2, 'pears', 5), (3, 'plums', 8)`);
    });
    afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
    afterAll(async () => {
      await admin(engine.type === "postgres" ? `DROP SCHEMA ${RUN} CASCADE` : `DROP DATABASE ${RUN}`).catch(() => {});
    });

    function recordSessions(): string[] {
      const ran: string[] = [];
      const adapter = getAdapter(engine.type);
      const open = adapter.openQuerySession.bind(adapter);
      spies.push(spyOn(adapter, "openQuerySession").mockImplementation(async (config) => {
        const session = await open(config);
        const recorded: DbQuerySession = { ...session, run: (text, maxRows) => { ran.push(text); return session.run(text, maxRows); } };
        return recorded;
      }));
      return ran;
    }

    it("answers an UPDATE with the changed rows as they were, read in the write's own transaction", async () => {
      const ran = recordSessions();
      const sql = `UPDATE ${table} SET qty = qty + 10 WHERE id IN (1, 2)`;
      const answer = body(await dbQuery({ connectionId: id, sql }, CALLER, APPROVE));
      expect(answer).toMatchObject({ rowsAffected: 2, columns: ["id", "name", "qty"], oldRowsCapped: false });
      expect([...answer.oldRows].sort((a: number[], b: number[]) => a[0]! - b[0]!)).toEqual([[1, "apples", 3], [2, "pears", 5]]);
      expect(ran).toEqual([engine.begin, `SELECT * FROM ${table} WHERE id IN (1, 2)`, sql, "COMMIT"]);
      expect(await qty(1)).toBe(13);
      expect(await qty(2)).toBe(15);
    });

    it("answers a DELETE with the deleted rows", async () => {
      const answer = body(await dbQuery({ connectionId: id, sql: `DELETE FROM ${table} WHERE name = 'plums'` }, CALLER, APPROVE));
      expect(answer).toMatchObject({ rowsAffected: 1, oldRows: [[3, "plums", 8]] });
      expect(await qty(3)).toBeUndefined();
    });

    it("rolls the read back with a write that fails, and leaves no transaction open", async () => {
      const ran = recordSessions();
      const failed = await dbQuery({ connectionId: id, sql: `UPDATE ${table} SET name = NULL WHERE id = 1` }, CALLER, APPROVE);
      expect(failed.isError).toBe(true);
      expect(ran).not.toContain("COMMIT");
      const answer = body(await dbQuery({ connectionId: id, sql: `UPDATE ${table} SET qty = 0 WHERE id = 1` }, CALLER, APPROVE));
      expect(answer).toMatchObject({ rowsAffected: 1, oldRows: [[1, "apples", 13]] });
      expect(await qty(1)).toBe(0);
    });

    it("runs a write whose rows it cannot name as typed, saying the old values were not captured", async () => {
      const other = engine.type === "postgres"
        ? `UPDATE ${table} AS t SET qty = 1 FROM ${table} AS u WHERE t.id = u.id AND u.id = 2`
        : `UPDATE ${table} SET qty = 1 WHERE id = 2 LIMIT 1`;
      const answer = body(await dbQuery({ connectionId: id, sql: other }, CALLER, APPROVE));
      expect(answer).toMatchObject({ rowsAffected: 1, oldRows: null });
      expect(answer.oldRowsNote).toContain("not captured");
      expect(await qty(2)).toBe(1);
    });
  });
}
