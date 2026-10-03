/**
 * The Query tab's session against real servers: one connection for the run, results cut at the
 * run's limit, Stop cancelling the statement running and leaving the session usable, a transaction
 * the script left open found and rolled back, errors that say where they are, and a readonly
 * connection refusing writes. Runs only when the servers are given, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *   bun test tests/integration/database-query-session.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import mysql2 from "mysql2/promise";
import postgres from "postgres";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { isReadonlyRefusal, QueryStatementError, ReadonlyViolationError } from "../../src/services/database/db-errors.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import type { DbConnectionConfig, DbQuerySession } from "../../src/types/database.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PG_URL = process.env.PPM_TEST_PG_URL;
const MYSQL_ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];
const sessions: DbQuerySession[] = [];

beforeAll(async () => {
  initAdapters();
  if (MYSQL_ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  for (const s of sessions) await s.close();
  await postgresService.closeAll();
  await readonlyPostgresService.closeAll();
  await mysqlService.closeAll();
  await readonlyMysqlService.closeAll();
});

async function open(config: DbConnectionConfig): Promise<DbQuerySession> {
  const session = await getAdapter(config.type).openQuerySession(config);
  sessions.push(session);
  return session;
}

async function failure(p: Promise<unknown>): Promise<QueryStatementError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QueryStatementError);
    return e as QueryStatementError;
  }
  throw new Error("expected the statement to fail");
}

async function eventually(check: () => Promise<boolean>, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe.skipIf(!PG_URL)("query session on Postgres", () => {
  const S = `ppm_qs_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const config = (readonly = false): DbConnectionConfig => ({ type: "postgres", connectionString: PG_URL!, readonly });
  const rows = async (table: string) => Number((await admin!.unsafe(`SELECT COUNT(*)::int AS n FROM ${S}.${table}`))[0]!.n);

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${S}`);
    await admin!.unsafe(`CREATE TABLE ${S}.t (id int PRIMARY KEY, name text)`);
    await admin!.unsafe(`INSERT INTO ${S}.t SELECT g, 'n' || g FROM generate_series(1, 5) g`);
    await admin!.unsafe(`CREATE SEQUENCE ${S}.seq`);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin!.end();
  });

  it("stops a huge SELECT at the run's limit without reading the rest", async () => {
    const session = await open(config());
    const start = performance.now();
    const { resultSets, command } = await session.run("SELECT g FROM generate_series(1, 2000000) g", 1_000);
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(resultSets).toHaveLength(1);
    expect(resultSets[0]!.rows).toHaveLength(1_000);
    expect(resultSets[0]!.rows[999]).toEqual([1000]);
    expect(resultSets[0]!.truncated).toBe(true);
    expect(command).toBeUndefined();
    const all = await session.run(`SELECT id FROM ${S}.t ORDER BY id`, 5);
    expect(all.resultSets[0]).toEqual({ columns: [{ name: "id", type: "integer" }], rows: [[1], [2], [3], [4], [5]], truncated: false });
    expect(all.command).toBe("SELECT");
  });

  it("reads every row of a statement whose command tag counts none: EXPLAIN, SHOW, CALL", async () => {
    const session = await open(config());
    const plain = async (text: string) => (await admin!.unsafe(text).values()).map((r) => [...r]);
    const plan = await session.run(`EXPLAIN SELECT id FROM ${S}.t WHERE id > 2`, 1_000);
    expect(plan.command).toBe("EXPLAIN");
    expect(plan.resultSets).toEqual([{ columns: [{ name: "QUERY PLAN", type: "text" }], rows: await plain(`EXPLAIN SELECT id FROM ${S}.t WHERE id > 2`), truncated: false }]);
    const all = await session.run("SHOW ALL", 1_000);
    expect(all.resultSets[0]!.rows).toEqual(await plain("SHOW ALL"));
    expect(all.resultSets[0]!.truncated).toBe(false);
    const few = await session.run("SHOW ALL", 5);
    expect(few.resultSets[0]!.rows).toHaveLength(5);
    expect(few.resultSets[0]!.truncated).toBe(true);
    await admin!.unsafe(`CREATE PROCEDURE ${S}.bump(INOUT x int) LANGUAGE plpgsql AS $$ BEGIN x := x + 1; END $$`);
    expect(await session.run(`CALL ${S}.bump(41)`, 100)).toMatchObject({ command: "CALL", resultSets: [{ rows: [[42]], truncated: false }] });
    // Over one fetch: the rows before the last fetch reach the reader as they come, the last ones only at the end.
    const branches = `EXPLAIN ${Array.from({ length: 6_000 }, (_, i) => `SELECT ${i}`).join(" UNION ALL ")}`;
    const expected = await plain(branches);
    expect(expected.length).toBeGreaterThan(5_000);
    const big = await session.run(branches, 10_000);
    expect(big.resultSets[0]!.rows).toEqual(expected);
  });

  it("describes the columns of a query that finds nothing, and keeps two of one name apart", async () => {
    const session = await open(config());
    const none = await session.run(`SELECT id, name FROM ${S}.t WHERE false`, 100);
    expect(none.resultSets).toEqual([{ columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }], rows: [], truncated: false }]);
    const twice = await session.run("SELECT 1 AS a, 2 AS a", 100);
    expect(twice.resultSets[0]!.columns.map((c) => c.name)).toEqual(["a", "a"]);
    expect(twice.resultSets[0]!.rows).toEqual([[1, 2]]);
  });

  it("names the command, counts only what a write wrote, and hands over the notices", async () => {
    const session = await open(config());
    expect(await session.run("CREATE TEMP TABLE scratch (a int)", 100)).toEqual({ resultSets: [], command: "CREATE TABLE", notices: [] });
    expect(await session.run("INSERT INTO scratch SELECT generate_series(1, 3)", 100)).toEqual({ resultSets: [], rowsAffected: 3, command: "INSERT", notices: [] });
    expect(await session.run("UPDATE scratch SET a = a * 10 WHERE a >= 2", 100)).toEqual({ resultSets: [], rowsAffected: 2, command: "UPDATE", notices: [] });
    // A SELECT's tag counts rows too, which it read rather than wrote.
    const read = await session.run("SELECT a FROM scratch ORDER BY a", 100);
    expect(read.resultSets[0]!.rows).toEqual([[1], [20], [30]]);
    expect(read.rowsAffected).toBeUndefined();
    const said = await session.run("DO $$ BEGIN RAISE NOTICE 'hello %', 42; RAISE WARNING 'careful'; END $$", 100);
    expect(said.notices).toEqual(["NOTICE: hello 42", "WARNING: careful"]);
    expect((await session.run("SELECT 1", 100)).notices).toEqual([]);
  });

  it("finds a transaction the script left open — failed or not — and rolls it back", async () => {
    const session = await open(config());
    expect(await session.rollbackOpenTransaction()).toBe(false);
    await session.run("BEGIN", 100);
    await session.run(`DELETE FROM ${S}.t`, 100);
    expect(await rows("t")).toBe(5);
    expect(await session.rollbackOpenTransaction()).toBe(true);
    expect(await rows("t")).toBe(5);
    await session.run("BEGIN", 100);
    await failure(session.run("SELECT 1 / 0", 100));
    expect(await session.rollbackOpenTransaction()).toBe(true);
    expect(await session.rollbackOpenTransaction()).toBe(false);
  });

  it("cancels the statement running and keeps the session", async () => {
    const session = await open(config());
    await session.run("SET application_name = 'ppm-qs-cancel'", 100);
    const start = performance.now();
    const running = failure(session.run("SELECT pg_sleep(30)", 100));
    await new Promise((r) => setTimeout(r, 300));
    session.cancel();
    const error = await running;
    expect(performance.now() - start).toBeLessThan(2_000);
    expect((error.cause as { code?: string }).code).toBe("57014");
    expect(error.fatal).toBe(false);
    expect((await session.run("SELECT current_setting('application_name')", 100)).resultSets[0]!.rows).toEqual([["ppm-qs-cancel"]]);
  });

  it("refuses COPY through the client before sending it, which would hang the session", async () => {
    const session = await open(config());
    for (const sql of [`COPY ${S}.t FROM STDIN`, `copy (select 1) to stdout with csv`]) {
      expect((await failure(session.run(sql, 100))).message).toContain("Import or Export");
    }
    expect((await session.run("SELECT 1", 100)).resultSets[0]!.rows).toEqual([[1]]);
  });

  it("says which character an error points at, and refuses two statements sent as one", async () => {
    const session = await open(config());
    const sql = `SELECT id,\n  nosuch FROM ${S}.t`;
    const error = await failure(session.run(sql, 100));
    expect(error.message).toContain("nosuch");
    expect(error.where).toEqual({ position: sql.indexOf("nosuch") + 1 });
    expect((await failure(session.run(`SELECT 1; DELETE FROM ${S}.t`, 100))).message).toContain("multiple commands");
    expect(await rows("t")).toBe(5);
  });

  it("writes every row of an INSERT … RETURNING even when it shows fewer", async () => {
    const session = await open(config());
    await session.run(`CREATE TABLE ${S}.ret (a int)`, 100);
    const { resultSets } = await session.run(`INSERT INTO ${S}.ret SELECT generate_series(1, 10) RETURNING a`, 3);
    expect(resultSets[0]!.rows).toEqual([[1], [2], [3]]);
    expect(resultSets[0]!.truncated).toBe(true);
    expect(await rows("ret")).toBe(10);
  });

  it("ends its connection when closed", async () => {
    const session = await open(config());
    const pid = Number((await session.run("SELECT pg_backend_pid()", 100)).resultSets[0]!.rows[0]![0]);
    await session.close();
    await session.close();
    expect(await eventually(async () => Number((await admin!`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE pid = ${pid}`)[0]!.n) === 0)).toBe(true);
  });

  it("refuses a write on a readonly connection, and the server refuses what reads like a read", async () => {
    const session = await open(config(true));
    const refused = await failure(session.run(`DELETE FROM ${S}.t`, 100));
    expect(refused.cause).toBeInstanceOf(ReadonlyViolationError);
    const sneaky = await failure(session.run(`SELECT nextval('${S}.seq')`, 100));
    expect(isReadonlyRefusal(sneaky.cause)).toBe(true);
    expect((await session.run(`SELECT COUNT(*)::int FROM ${S}.t`, 100)).resultSets[0]!.rows).toEqual([[5]]);
    expect(await session.rollbackOpenTransaction()).toBe(false);
    expect(await rows("t")).toBe(5);
  });
});

for (const engine of MYSQL_ENGINES) {
  describe.skipIf(!engine.url)(`query session on ${engine.type}`, () => {
    const DB = `ppm_qs_${engine.type}_${RUN}`;
    let admin: mysql2.Connection;
    const url = () => {
      const u = new URL(engine.url!);
      u.pathname = `/${DB}`;
      return u.toString();
    };
    const config = (readonly = false): DbConnectionConfig => ({ type: engine.type, connectionString: url(), readonly });
    const rows = async (table: string) => Number(((await admin.query(`SELECT COUNT(*) AS n FROM \`${DB}\`.${table}`))[0] as { n: number }[])[0]!.n);

    beforeAll(async () => {
      admin = await mysql2.createConnection({ uri: engine.url!, multipleStatements: true });
      await admin.query(`CREATE DATABASE \`${DB}\``);
      await admin.query(`USE \`${DB}\``);
      await admin.query("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))");
      await admin.query("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')");
      await admin.query("CREATE TABLE many (n INT PRIMARY KEY)");
      await admin.query("INSERT INTO many SELECT a.i * 100 + b.i * 10 + c.i FROM (SELECT 0 i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a, (SELECT 0 i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b, (SELECT 0 i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c");
      await admin.query("CREATE PROCEDURE two_results() BEGIN SELECT n FROM many ORDER BY n; SELECT 'done' AS state; END");
    });

    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
      await admin.end();
    });

    it("keeps the run's limit of rows, an explicit LIMIT and a CALL's results included", async () => {
      const session = await open(config());
      expect(session.splitOptions).toEqual({ backslashEscapes: true });
      const cut = await session.run("SELECT n FROM many ORDER BY n", 100);
      expect(cut.resultSets).toHaveLength(1);
      expect(cut.resultSets[0]!.rows).toHaveLength(100);
      expect(cut.resultSets[0]!.rows[99]).toEqual([99]);
      expect(cut.resultSets[0]!.truncated).toBe(true);
      // The server sends one row past the limit and stops there: the rest never cross the wire.
      expect(Number((await session.run("SELECT @@SESSION.sql_select_limit", 100)).resultSets[0]!.rows[0]![0])).toBe(101);
      const limited = await session.run("SELECT n FROM many ORDER BY n LIMIT 500", 100);
      expect(limited.resultSets[0]!.rows).toHaveLength(100);
      expect(limited.resultSets[0]!.truncated).toBe(true);
      const whole = await session.run("SELECT id FROM t ORDER BY id", 5);
      expect(whole.resultSets[0]!.truncated).toBe(false);
      expect(whole.resultSets[0]!.rows).toEqual([[1], [2], [3], [4], [5]]);
      const call = await session.run("CALL two_results()", 10);
      expect(call.resultSets.map((r) => [r.rows.length, r.truncated])).toEqual([[10, true], [1, false]]);
      expect(call.resultSets[1]!.rows).toEqual([["done"]]);
      expect(call.rowsAffected).toBeUndefined();
    });

    it("describes the columns of a query that finds nothing, and keeps two of one name apart", async () => {
      const session = await open(config());
      const none = await session.run("SELECT id, name FROM t WHERE 1 = 0", 100);
      expect(none.resultSets).toEqual([{ columns: [{ name: "id", type: "int" }, { name: "name", type: "varchar" }], rows: [], truncated: false }]);
      const twice = await session.run("SELECT 'x' AS a, 'y' AS a", 100);
      expect(twice.resultSets[0]!.columns.map((c) => c.name)).toEqual(["a", "a"]);
      expect(twice.resultSets[0]!.rows).toEqual([["x", "y"]]);
    });

    it("counts the rows a write changed, none matched included, and nothing for DDL", async () => {
      const session = await open(config());
      expect(await session.run("UPDATE t SET name = CONCAT(name, '!') WHERE id <= 2", 100)).toEqual({ resultSets: [], rowsAffected: 2, notices: [] });
      expect(await session.run("UPDATE t SET name = 'x' WHERE id = 99", 100)).toMatchObject({ rowsAffected: 0 });
      expect((await session.run("CREATE TEMPORARY TABLE scratch (a INT)", 100)).rowsAffected).toBeUndefined();
      await session.run("SET @x = 41", 100);
      // BIGINT, which reaches the browser as a string so no digit is lost.
      expect((await session.run("SELECT @x + 1 AS y", 100)).resultSets[0]!.rows).toEqual([["42"]]);
    });

    it("finds a transaction the script left open and rolls it back", async () => {
      const session = await open(config());
      expect(await session.rollbackOpenTransaction()).toBe(false);
      await session.run("START TRANSACTION", 100);
      await session.run("DELETE FROM t", 100);
      expect(await rows("t")).toBe(5);
      expect(await session.rollbackOpenTransaction()).toBe(true);
      expect(await rows("t")).toBe(5);
      expect(await session.rollbackOpenTransaction()).toBe(false);
    });

    it("stops a statement on Stop and keeps the session", async () => {
      const session = await open(config());
      await session.run("SET @kept = 'yes'", 100);
      const start = performance.now();
      // MySQL ends an interrupted SLEEP() successfully, MariaDB with ER_QUERY_INTERRUPTED: either way it ends now.
      const running = session.run("SELECT SLEEP(30)", 100).then(() => null, (e) => e);
      await new Promise((r) => setTimeout(r, 300));
      session.cancel();
      const outcome = await running;
      expect(performance.now() - start).toBeLessThan(3_000);
      if (outcome) expect((outcome as QueryStatementError).fatal).toBe(false);
      expect((await session.run("SELECT @kept", 100)).resultSets[0]!.rows).toEqual([["yes"]]);
    });

    it("leaves the next statement alone when Stop comes with nothing running", async () => {
      // No pooled connection left to send a KILL QUERY at once: one would have to connect first,
      // and land in the SLEEP below — which MySQL ends early with 1, MariaDB with an error.
      await mysqlService.closeAll();
      const session = await open(config());
      session.cancel();
      const slept = await session.run("SELECT SLEEP(0.5)", 100);
      expect(Number(slept.resultSets[0]!.rows[0]![0])).toBe(0);
    });

    it("says which line of the statement an error is on", async () => {
      const session = await open(config());
      const error = await failure(session.run("SELECT id,\n  name\nFROMM t", 100));
      expect(error.where).toEqual({ line: 3 });
      expect(error.message).toContain("at line 3");
    });

    it("ends its connection when closed", async () => {
      const session = await open(config());
      const id = Number((await session.run("SELECT CONNECTION_ID()", 100)).resultSets[0]!.rows[0]![0]);
      await session.close();
      await session.close();
      const alive = async () => (((await admin.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID = ?", [id]))[0] as { n: number }[])[0]!.n);
      expect(await eventually(async () => Number(await alive()) === 0)).toBe(true);
    });

    it("refuses a write on a readonly connection, and still reads", async () => {
      const session = await open(config(true));
      const refused = await failure(session.run("DELETE FROM t", 100));
      expect(refused.cause).toBeInstanceOf(ReadonlyViolationError);
      expect((await session.run("SELECT COUNT(*) AS n FROM t", 100)).resultSets[0]!.rows).toEqual([["5"]]);
      expect(await session.rollbackOpenTransaction()).toBe(false);
      expect(await rows("t")).toBe(5);
    });
  });
}
