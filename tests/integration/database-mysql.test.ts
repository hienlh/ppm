/**
 * MySQL and MariaDB through the same routes Postgres and SQLite answer. Runs
 * only when the URLs name disposable servers, e.g.
 *
 *   docker run --rm -d -p 127.0.0.1:23306:3306 -e MYSQL_ROOT_PASSWORD=x mysql:8.4
 *   docker run --rm -d -p 127.0.0.1:23307:3306 -e MARIADB_ROOT_PASSWORD=x mariadb:11
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-mysql.test.ts
 *
 * Each run creates one database named after itself on each server and drops
 * it at the end. The driver is installed the way Settings installs it, into
 * this run's PPM directory, except that the download is a copy of the
 * repository's own `mysql2` (a devDependency) — so every query here goes
 * through the bundle an install really builds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { Hono } from "hono";
import mysql2 from "mysql2/promise";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { installDbDriver, uninstallDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { parseGridRequest } from "../../src/services/database/grid-query-builder.ts";
import { countGridRows, fetchGridPage, type GridTarget } from "../../src/services/database/grid.service.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { registerDbCommands } from "../../src/cli/commands/db-cmd.ts";
import { getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { ChangesetApplyResult, ChangesetFailure, ChangesetPreview } from "../../src/shared/db-changeset.ts";
import type { DbDriverMissingBody } from "../../src/shared/db-drivers.ts";
import type { GridCountResponse, GridResponse, QueryRunResponse } from "../../src/shared/db-grid.ts";
import type { DbObjectList, DbTableStructure } from "../../src/shared/db-structure.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

const app = () => new Hono().route("/db", databaseRoutes);

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; error?: string; json: Record<string, unknown> }> {
  const res = await app().request(path, {
    method,
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error, json: json as Record<string, unknown> };
}

/** What the CLI printed, without its colours. */
const plain = (args: unknown[]) => args.join(" ").replace(/\x1b\[[0-9;]*m/g, "");

/** The CLI with its exits turned into throws and its output captured. */
function cli() {
  const out: string[] = [];
  const errors: string[] = [];
  const spies = [
    spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never),
    spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(plain(args)); }),
    spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(plain(args)); }),
  ];
  const run = async (...args: string[]) => {
    const program = new Command();
    registerDbCommands(program);
    await program.parseAsync(["db", ...args], { from: "user" });
  };
  return { out, errors, run, restore: () => spies.forEach((s) => s.mockRestore()) };
}

// bun test runs in UTC, where a driver that shifts DATETIME by the local zone looks correct.
const originalTz = process.env.TZ;

beforeAll(async () => {
  process.env.TZ = "Asia/Ho_Chi_Minh";
  initAdapters();
  if (ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  // Assigned back, never deleted: once TZ is deleted, Bun ignores every later
  // assignment and the rest of the run stays in this zone.
  process.env.TZ = originalTz ?? "UTC";
  await mysqlService.closeAll();
  await readonlyMysqlService.closeAll();
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(engine.type, () => {
    const DB = `ppm_it_${engine.type}_${RUN}`;
    const url = `${engine.url?.replace(/\/$/, "")}/${DB}`;
    let admin: mysql2.Connection;
    let rw = 0;
    let ro = 0;
    const rows = async (sql: string) => (await admin.query(sql))[0] as Record<string, unknown>[];
    const grid = (body: object, id = rw) => call<GridResponse>("POST", `/db/connections/${id}/grid`, { schema: DB, ...body });
    const query = (sql: string, id = rw) => call<QueryRunResponse>("POST", `/db/connections/${id}/query`, { sql });
    const apply = (body: object, id = rw) =>
      call<ChangesetApplyResult & ChangesetFailure>("POST", `/db/connections/${id}/changeset/apply`, { schema: DB, ...body });
    const preview = (body: object) => call<ChangesetPreview>("POST", `/db/connections/${rw}/changeset/preview`, { schema: DB, ...body });
    const target = (): GridTarget => ({ type: engine.type, adapter: getAdapter(engine.type), config: { type: engine.type, connectionString: url } });

    beforeAll(async () => {
      admin = await mysql2.createConnection({
        uri: engine.url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true, dateStrings: true, supportBigNumbers: true,
      });
      await admin.query(`
        CREATE DATABASE ${DB} CHARACTER SET utf8mb4;
        USE ${DB};
        CREATE TABLE users (
          id BIGINT PRIMARY KEY, email VARCHAR(100), amount DECIMAL(30,10), ratio FLOAT, score DOUBLE,
          created DATETIME, day DATE, at_time TIME, meta JSON, photo BLOB, flags BIT(8), active TINYINT(1),
          mood ENUM('happy','sad'), tags SET('a','b','c'), yr YEAR
        );
        INSERT INTO users VALUES
          (9007199254740993, 'Alice@Example.com', 12345678901234567890.1234567891, 1.1, 0.1,
           '2024-01-01 10:00:00', '2024-01-01', '10:11:12', '{"k": 1}', X'0102', b'00000101', 1, 'happy', 'a,c', 2024),
          (9007199254740992, 'bob@example.com', 1, 2.5, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 'sad', '', NULL);
        CREATE VIEW active_users AS SELECT id, email FROM users WHERE active = 1;
        CREATE TABLE people (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, age INT);
        CREATE TABLE memberships (org VARCHAR(10), user_id INT, role VARCHAR(10), PRIMARY KEY (org, user_id));
        CREATE TABLE owners (id INT PRIMARY KEY);
        CREATE TABLE orders (id INT PRIMARY KEY, owner_id INT, CONSTRAINT fk_owner FOREIGN KEY (owner_id) REFERENCES owners (id));
        CREATE TABLE items (id INT PRIMARY KEY, order_id INT, CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE);
        CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(20), manager_id INT, CONSTRAINT fk_manager FOREIGN KEY (manager_id) REFERENCES employees (id));
        CREATE TABLE defaults_demo (
          id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20) DEFAULT 'abc', n INT DEFAULT 5,
          created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, total INT AS (n * 2),
          CONSTRAINT n_positive CHECK (n >= 0), KEY idx_label (label(5)), UNIQUE KEY uq_n (n)
        );
        CREATE TABLE counter (n INT NOT NULL);
        INSERT INTO counter VALUES (0);
        CREATE TABLE likes (id INT PRIMARY KEY, u VARCHAR(20) CHARACTER SET utf8mb4, l VARCHAR(20) CHARACTER SET latin1);
        INSERT INTO likes VALUES (1, '50% off', '50% off'), (2, '500 units', '500 units'), (3, 'a_b', 'a_b'), (4, 'axb', 'axb'),
          (5, CONCAT('C:', CHAR(92), 'temp'), CONCAT('C:', CHAR(92), 'temp')), (6, 'C:temp', 'C:temp');
        -- 100^4 rows, each one tested: counting takes far longer than any timeout here, while a
        -- page streams at once. Without the condition MySQL counts a cross join by multiplying.
        CREATE TABLE seq (n INT PRIMARY KEY);
        INSERT INTO seq WITH RECURSIVE r AS (SELECT 0 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 99) SELECT n FROM r;
        CREATE VIEW slow AS SELECT a.n AS a, b.n AS b, c.n AS c, d.n AS d FROM seq a, seq b, seq c, seq d
          WHERE a.n + b.n + c.n + d.n >= 0;
        ANALYZE TABLE users;
      `);
      // Declared DETERMINISTIC only so a server with binary logging accepts them from a non-SUPER session.
      await admin.query("CREATE FUNCTION bump() RETURNS INT DETERMINISTIC BEGIN UPDATE counter SET n = n + 1; RETURN 1; END");
      // Clears the session's read-only flag from inside a SELECT, which both servers allow.
      await admin.query("CREATE FUNCTION unlock_rw() RETURNS INT DETERMINISTIC BEGIN SET SESSION transaction_read_only = OFF; RETURN 1; END");
      await admin.query("CREATE VIEW bumping AS SELECT bump() AS b");

      setDb(openTestDb());
      rw = insertConnection(engine.type, `${engine.type}-rw`, { type: engine.type, connectionString: url }).id;
      updateConnection(rw, { readonly: 0 });
      ro = insertConnection(engine.type, `${engine.type}-ro`, { type: engine.type, connectionString: url }).id;
    });

    beforeEach(async () => {
      getAuditDb().exec("DELETE FROM query_log");
      await admin.query(`
        DELETE FROM items; DELETE FROM orders; DELETE FROM owners; DELETE FROM people; DELETE FROM memberships;
        UPDATE employees SET manager_id = NULL; DELETE FROM employees;
        INSERT INTO people VALUES (1, 'a', 10), (2, 'b', 20), (3, 'c', 30);
        INSERT INTO memberships VALUES ('a', 1, 'r1'), ('a', 2, 'r2'), ('b', 1, 'r3');
        INSERT INTO owners VALUES (1), (2);
        INSERT INTO orders VALUES (10, 1), (11, 1), (20, 2);
        INSERT INTO items VALUES (100, 10), (101, 11), (200, 20);
        INSERT INTO employees VALUES (1, 'boss', NULL), (2, 'lead', 1), (3, 'dev', 2);
        UPDATE counter SET n = 0;
      `);
    });

    afterAll(async () => {
      await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin?.end();
    });

    it("runs in a zone where a shifted DATETIME would show", () => {
      expect(new Date(2024, 0, 1).getTimezoneOffset()).toBe(-420);
    });

    describe("reading", () => {
      it("lists the tables, views and functions of the connection's database", async () => {
        const res = await call<DbObjectList>("GET", `/db/connections/${rw}/objects`);
        expect(res.status).toBe(200);
        expect(res.data.schemas).toEqual([DB]);
        const byName = new Map(res.data.objects.map((o) => [o.name, o]));
        expect(byName.get("users")).toMatchObject({ schema: DB, kind: "table", rowEstimate: expect.any(Number) });
        expect(byName.get("active_users")).toMatchObject({ kind: "view" });
        expect(byName.get("active_users")!.rowEstimate).toBeUndefined();
        expect(byName.get("bump")).toMatchObject({ kind: "function" });
      });

      it("returns every value as the server prints it", async () => {
        const { status, data } = await grid({ table: "users", sort: [{ column: "id", dir: "DESC" }] });
        expect(status).toBe(200);
        expect(data.sql).toContain(`FROM \`${DB}\`.\`users\``);
        expect(data.rows[0]).toEqual([
          "9007199254740993", "Alice@Example.com", "12345678901234567890.1234567891", 1.1, 0.1,
          "2024-01-01 10:00:00", "2024-01-01", "10:11:12", expect.stringMatching(/^\{"k": ?1\}$/),
          { $binary: "AQI=", size: 2 }, 5, 1, "happy", "a,c", 2024,
        ]);
        expect(data.rows[1]!.slice(0, 5)).toEqual(["9007199254740992", "bob@example.com", "1.0000000000", 2.5, null]);
      });

      it("filters text case-insensitively and numbers by their digits, and matches a big integer exactly", async () => {
        const filter = (column: string, cond: object) => grid({ table: "users", filters: [{ column, anyOf: [[cond]] }] });
        expect((await filter("email", { op: "contains", value: "alice@EXAMPLE" })).data.rows).toHaveLength(1);
        expect((await filter("id", { op: "contains", value: "40993" })).data.rows).toHaveLength(1);
        expect((await filter("id", { op: "eq", value: "9007199254740993" })).data.rows.map((r) => r[1])).toEqual(["Alice@Example.com"]);
        expect((await filter("id", { op: "eq", value: "9007199254740992" })).data.rows.map((r) => r[1])).toEqual(["bob@example.com"]);
        expect((await filter("created", { op: "dateRange", from: "2024-01-01 10:00:00", to: "2024-01-01 10:00:01", offset: "+07:00" })).data.rows).toHaveLength(1);
      });

      it("matches %, _ and \\ in a filter as themselves, NO_BACKSLASH_ESCAPES in the server's sql_mode or not", async () => {
        // That mode leaves LIKE with no default escape character: on MySQL for every column, on
        // MariaDB for the latin1 one. The connection is one of its own, so its pool opens in that mode.
        const found = async (id: number, column: string, value: string) =>
          (await grid({ table: "likes", filters: [{ column, anyOf: [[{ op: "contains", value }]] }] }, id)).data.rows.map((r) => r[0]);
        const expectLiteral = async (id: number) => {
          for (const column of ["u", "l"]) {
            expect(await found(id, column, "50%")).toEqual([1]);
            expect(await found(id, column, "a_b")).toEqual([3]);
            expect(await found(id, column, "C:\\t")).toEqual([5]);
          }
        };
        await expectLiteral(rw);
        const nbe = insertConnection(engine.type, `${engine.type}-no-backslash-escapes`, { type: engine.type, connectionString: url }).id;
        updateConnection(nbe, { readonly: 0 });
        const init = spyOn(mysqlService as unknown as { sessionInit(): string[] }, "sessionInit")
          .mockReturnValue(["SET NAMES utf8mb4", "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'"]);
        try {
          expect(String((await query("SELECT @@SESSION.sql_mode", nbe)).data.rows[0]![0])).toContain("NO_BACKSLASH_ESCAPES");
          await expectLiteral(nbe);
        } finally {
          init.mockRestore();
          await call("DELETE", `/db/connections/${nbe}`);
        }
      });

      it("sorts and pages on the server", async () => {
        const sorted = await grid({ table: "people", sort: [{ column: "age", dir: "DESC" }], limit: 2 });
        expect(sorted.data.rows.map((r) => r[1])).toEqual(["c", "b"]);
        expect(sorted.data.hasMore).toBe(true);
        const next = await grid({ table: "people", sort: [{ column: "age", dir: "DESC" }], limit: 2, offset: 2 });
        expect(next.data.rows.map((r) => r[1])).toEqual(["a"]);
      });

      it("counts exactly, and gives the engine's estimate only for an unfiltered table", async () => {
        const all = await call<GridCountResponse>("POST", `/db/connections/${rw}/grid/count`, { table: "users", schema: DB });
        expect(all.data).toMatchObject({ count: 2, timedOut: false, estimate: expect.any(Number) });
        const filtered = await call<GridCountResponse>("POST", `/db/connections/${rw}/grid/count`, {
          table: "users", schema: DB, filters: [{ column: "active", anyOf: [[{ op: "isFalse" }]] }],
        });
        expect(filtered.data).toEqual({ count: 1, estimate: null, timedOut: false });
      });

      it("gives up on a count that outruns its timeout, and kills it on the server", async () => {
        const started = Date.now();
        const result = await countGridRows(target(), parseGridRequest({ table: "slow", schema: DB }, null), 200);
        expect(result).toMatchObject({ count: null, timedOut: true });
        expect(Date.now() - started).toBeLessThan(5_000);
        const running = await rows(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%\`slow\`%' AND ID <> CONNECTION_ID()`);
        expect(Number(running[0]!.n)).toBe(0);
        // A statement slower than the count's timeout still runs afterwards, on the same pool.
        const after = await query("SELECT SLEEP(0.3) AS slept");
        expect(after.status).toBe(200);
      });

      it("opens a page without counting the table", async () => {
        const started = Date.now();
        const page = await fetchGridPage(target(), parseGridRequest({ table: "slow", schema: DB, limit: 5 }, null));
        expect(page.response.rows).toHaveLength(5);
        expect(page.response.hasMore).toBe(true);
        expect(Date.now() - started).toBeLessThan(3_000);
      });

      it("refuses a second statement in a grid SELECT at the driver", async () => {
        await expect(getAdapter(engine.type).selectRows({ type: engine.type, connectionString: url }, { sql: "SELECT 1; SELECT 2", params: [] }))
          .rejects.toThrow(/syntax/i);
      });

      it("describes a table: defaults as SQL, generated and auto-increment columns, keys, indexes, checks", async () => {
        const res = await call<DbTableStructure>("GET", `/db/connections/${rw}/structure?table=defaults_demo&schema=${DB}`);
        expect(res.status).toBe(200);
        const col = (name: string) => res.data.columns.find((c) => c.name === name)!;
        expect(col("id")).toMatchObject({ autoIncrement: true, nullable: false });
        expect(col("label").defaultValue).toBe("'abc'");
        expect(col("n").defaultValue).toBe("5");
        expect(col("created").defaultValue).toMatch(/^current_timestamp(\(\))?$/i);
        expect(col("total")).toMatchObject({ generated: true, defaultValue: null });
        expect(res.data.primaryKey).toEqual({ name: "PRIMARY", columns: ["id"] });
        expect(res.data.indexes.find((i) => i.name === "idx_label")).toMatchObject({ columns: ["label(5)"], unique: false });
        expect(res.data.uniques).toEqual([{ name: "uq_n", columns: ["n"] }]);
        expect(res.data.checks.map((c) => c.name)).toContain("n_positive");
      });

      it("tells the grid which key the server numbers: AUTO_INCREMENT, never an INT key with no default", async () => {
        const first = async (table: string) => (await call<{ name: string; autoIncrement: boolean; defaultValue: string | null }[]>(
          "GET", `/db/connections/${rw}/schema?table=${table}&schema=${DB}`)).data[0]!;
        expect(await first("defaults_demo")).toMatchObject({ name: "id", autoIncrement: true, defaultValue: null });
        expect(await first("people")).toMatchObject({ name: "id", autoIncrement: false, defaultValue: null });
      });

      it("reads an empty schema as the connection's own database, as the browser sends it", async () => {
        const named = await call<{ name: string }[]>("GET", `/db/connections/${rw}/schema?table=users&schema=${DB}`);
        const empty = await call<{ name: string }[]>("GET", `/db/connections/${rw}/schema?table=users&schema=`);
        expect(named.data.length).toBeGreaterThan(3);
        expect(empty.data).toEqual(named.data);
        const exported = await app().request(`/db/connections/${rw}/export?table=people&schema=&format=json`);
        expect(exported.status).toBe(200);
        expect(((await exported.json()) as unknown[]).length).toBeGreaterThan(0);
      });

      it("names the keys pointing at a table, its own included", async () => {
        const res = await call<DbTableStructure>("GET", `/db/connections/${rw}/structure?table=employees&schema=${DB}`);
        expect(res.data.foreignKeys).toEqual([expect.objectContaining({ name: "fk_manager", columns: ["manager_id"], refTable: "employees", refColumns: ["id"] })]);
        expect(res.data.references.map((r) => r.name)).toEqual(["fk_manager"]);
      });
    });

    describe("the query tab", () => {
      it("keeps repeated column names and describes an empty result", async () => {
        const dup = await query(`SELECT id AS x, age AS x FROM ${DB}.people WHERE id = 1`);
        expect(dup.data.columns.map((c) => c.name)).toEqual(["x", "x"]);
        expect(dup.data.rows).toEqual([[1, 10]]);
        const empty = await query(`SELECT id, email FROM ${DB}.users WHERE 1 = 0`);
        expect(empty.data.columns.map((c) => c.name)).toEqual(["id", "email"]);
        expect(empty.data.rows).toEqual([]);
      });

      it("answers the last result of several statements, and counts the rows a write matched", async () => {
        const script = await query("SELECT 'one' AS a; SELECT 'two' AS b");
        expect(script.data.columns.map((c) => c.name)).toEqual(["b"]);
        expect(script.data.rows).toEqual([["two"]]);
        // Writing a value back unchanged still matched one row.
        const write = await query(`UPDATE ${DB}.people SET age = age WHERE id = 1`);
        expect(write.data).toMatchObject({ rowsAffected: 1, changeType: "modify" });
      });

      it("splits a DELIMITER script the way the mysql client does", async () => {
        const res = await query([
          `USE ${DB};`,
          "DELIMITER //",
          "CREATE PROCEDURE two_results() BEGIN SELECT 'one' AS first; SELECT 'two' AS second; END //",
          "DELIMITER ;",
          "CALL two_results();",
          "DROP PROCEDURE two_results;",
        ].join("\n"));
        expect(res.status).toBe(200);
        expect(res.data.columns.map((c) => c.name)).toEqual(["second"]);
        expect(res.data.rows).toEqual([["two"]]);
      });

      it("rolls back a transaction the statements left open, and says so", async () => {
        const res = await query(`START TRANSACTION; UPDATE ${DB}.people SET age = 99 WHERE id = 1`);
        expect(res.status).toBe(500);
        expect(res.error).toContain("did not end it, so it was rolled back");
        expect(await rows(`SELECT age FROM ${DB}.people WHERE id = 1`)).toEqual([{ age: 10 }]);
      });

      it("does not carry one request's session settings into the next", async () => {
        await query("SET @leftover = 42");
        expect((await query("SELECT @leftover AS v")).data.rows).toEqual([[null]]);
      });
    });

    describe("saving", () => {
      it("saves two edits and a new row in one transaction", async () => {
        const res = await apply({
          table: "people",
          updates: [{ key: { id: 1 }, set: { name: "A" } }, { key: { id: 2 }, set: { age: 21 } }],
          inserts: [{ id: 4, name: "d", age: 40 }],
        });
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ inserted: 1, updated: 2 });
        expect(await rows(`SELECT id, name, age FROM ${DB}.people ORDER BY id`)).toEqual([
          { id: 1, name: "A", age: 10 }, { id: 2, name: "b", age: 21 }, { id: 3, name: "c", age: 30 }, { id: 4, name: "d", age: 40 },
        ]);
      });

      it("saves nothing when a later statement fails, and names that statement", async () => {
        const res = await apply({
          table: "people",
          updates: [{ key: { id: 1 }, set: { name: "A" } }, { key: { id: 2 }, set: { age: 21 } }],
          inserts: [{ id: 4, age: 40 }],
        });
        expect(res.status).toBe(400);
        expect(res.error).toStartWith("Statement 1 of 3 failed: Field 'name' doesn't have a default value. Nothing was saved.");
        expect(res.data).toMatchObject({ statementIndex: 0, statementCount: 3, sql: `INSERT INTO \`${DB}\`.\`people\` (\`id\`, \`age\`) VALUES (4, 40)` });
        expect(await rows(`SELECT id, name, age FROM ${DB}.people ORDER BY id`)).toEqual([
          { id: 1, name: "a", age: 10 }, { id: 2, name: "b", age: 20 }, { id: 3, name: "c", age: 30 },
        ]);
      });

      it("addresses a BIGINT key past 2^53 and writes DECIMAL(30,10) without losing a digit", async () => {
        const res = await apply({
          table: "users",
          updates: [{ key: { id: "9007199254740993" }, set: { amount: "98765432109876543210.0123456789" } }],
        });
        expect(res.status).toBe(200);
        expect(await rows(`SELECT CAST(id AS CHAR) AS id, CAST(amount AS CHAR) AS amount FROM ${DB}.users ORDER BY id`)).toEqual([
          { id: "9007199254740992", amount: "1.0000000000" },
          { id: "9007199254740993", amount: "98765432109876543210.0123456789" },
        ]);
        const back = await grid({ table: "users", filters: [{ column: "id", anyOf: [[{ op: "eq", value: "9007199254740993" }]] }] });
        expect(back.data.rows[0]![2]).toBe("98765432109876543210.0123456789");
        await admin.query(`UPDATE ${DB}.users SET amount = 12345678901234567890.1234567891 WHERE id = 9007199254740993`);
      });

      it("edits and deletes exactly one row of a table keyed by two columns", async () => {
        const res = await apply({
          table: "memberships",
          updates: [{ key: { org: "a", user_id: 1 }, set: { role: "admin" } }],
          deletes: [{ key: { org: "b", user_id: 1 } }],
        });
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ updated: 1, deleted: 1 });
        expect(await rows(`SELECT * FROM ${DB}.memberships ORDER BY org, user_id`)).toEqual([
          { org: "a", user_id: 1, role: "admin" }, { org: "a", user_id: 2, role: "r2" },
        ]);
      });

      it("refuses a key that matches several rows", async () => {
        const res = await apply({ table: "memberships", updates: [{ key: { user_id: 1 }, set: { role: "x" } }] });
        expect(res.status).toBe(409);
        expect(res.data.affected).toBe(2);
        expect(await rows(`SELECT COUNT(*) AS n FROM ${DB}.memberships WHERE role = 'x'`)).toEqual([{ n: 0 }]);
      });

      it("refuses to overwrite a value someone else changed, and saves one they did not touch", async () => {
        await admin.query(`UPDATE ${DB}.people SET name = 'z' WHERE id = 1`);
        const stale = await apply({ table: "people", updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "a" } }] });
        expect(stale.status).toBe(409);
        expect(await rows(`SELECT name FROM ${DB}.people WHERE id = 1`)).toEqual([{ name: "z" }]);
        const fresh = await apply({ table: "people", updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "z", age: 10 } }] });
        expect(fresh.status).toBe(200);
      });

      it("previews the tables pointing at a deleted row, and deletes the ticked ones first", async () => {
        const p = await preview({ table: "owners", deletes: [{ key: { id: 1 } }] });
        expect(p.status).toBe(200);
        expect(p.data.script).toBe(`DELETE FROM \`${DB}\`.\`owners\` WHERE \`id\` = 1;`);
        expect(p.data.references.map((r) => [r.table, r.paths, r.cascadesInDb])).toEqual([
          ["items", [["items", "orders", "owners"]], false],
          ["orders", [["orders", "owners"]], false],
        ]);

        const refused = await apply({ table: "owners", deletes: [{ key: { id: 1 } }] });
        expect(refused.status).toBe(400);
        expect(refused.error).toContain("a foreign key constraint fails");

        // Ticking orders is enough: items follow by their own ON DELETE CASCADE.
        const res = await apply({ table: "owners", deletes: [{ key: { id: 1 } }], cascade: [{ table: "orders" }] });
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ deleted: 1, cascaded: 2 });
        expect(await rows(`SELECT id FROM ${DB}.owners`)).toEqual([{ id: 2 }]);
        expect(await rows(`SELECT id FROM ${DB}.items`)).toEqual([{ id: 200 }]);
      });

      it("leaves a table's key to itself out of the cascade, as DBGate does, and saves nothing", async () => {
        const p = await preview({ table: "employees", deletes: [{ key: { id: 2 } }] });
        expect(p.data.references).toEqual([]);
        const res = await apply({ table: "employees", deletes: [{ key: { id: 2 } }] });
        expect(res.status).toBe(400);
        expect(res.error).toContain("a foreign key constraint fails");
        expect(await rows(`SELECT id FROM ${DB}.employees ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      });
    });

    describe("a readonly connection", () => {
      it("refuses an UPDATE before sending it, and audits it as blocked", async () => {
        const res = await query(`UPDATE ${DB}.people SET age = 1`, ro);
        expect(res.status).toBe(403);
        expect(await rows(`SELECT age FROM ${DB}.people WHERE id = 1`)).toEqual([{ age: 10 }]);
        expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "blocked" });
      });

      it("is refused by the server when a SELECT calls a function that writes", async () => {
        const res = await query(`SELECT ${DB}.bump() AS b`, ro);
        expect(res.status).toBe(403);
        expect(res.error).toContain("READ ONLY transaction");
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 0 }]);
        expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "blocked" });
      });

      it("runs the same SELECT on a writable connection, so the refusal is readonly's", async () => {
        expect((await query(`SELECT ${DB}.bump() AS b`)).status).toBe(200);
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 1 }]);
      });

      it("cannot switch its own session back to read-write", async () => {
        for (const sql of [
          `SET SESSION TRANSACTION READ WRITE; UPDATE ${DB}.people SET age = 1`,
          `SET SESSION transaction_read_only = OFF; SELECT ${DB}.bump()`,
          `COMMIT; UPDATE ${DB}.people SET age = 1`,
        ]) {
          expect((await query(sql, ro)).status).toBe(403);
        }
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 0 }]);
      });

      it("stays read-only after a function clears the session's flag", async () => {
        const res = await query(`SELECT ${DB}.unlock_rw() AS u; SELECT ${DB}.bump() AS b`, ro);
        expect(res.status).toBe(403);
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 0 }]);
      });

      it("keeps a pooled session read-only after a grid filter cleared its flag", async () => {
        const filtered = (fn: string) => grid({ table: "people", filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: `$$ > 0 AND ${DB}.${fn}() > 0` }]] }] }, ro);
        // Concurrent, so every connection in the pool runs one.
        expect((await Promise.all([1, 2, 3].map(() => filtered("unlock_rw")))).map((r) => r.status)).toEqual([200, 200, 200]);
        expect((await Promise.all([1, 2, 3].map(() => filtered("bump")))).map((r) => r.status)).toEqual([403, 403, 403]);
        const legacy = await call("GET", `/db/connections/${ro}/data?table=bumping&schema=${DB}`);
        expect(legacy.status).toBe(500);
        expect(legacy.error).toContain("READ ONLY transaction");
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 0 }]);
      });

      it("answers reads, several statements and SHOW included", async () => {
        const res = await query(`SELECT 1 AS a; SELECT name FROM ${DB}.people ORDER BY id`, ro);
        expect(res.status).toBe(200);
        expect(res.data.rows).toEqual([["a"], ["b"], ["c"]]);
        expect((await query(`SHOW CREATE TABLE ${DB}.people`, ro)).status).toBe(200);
      });

      it("refuses a grid condition written in SQL that writes", async () => {
        const res = await grid({ table: "people", filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: `$$ > 0 AND ${DB}.bump() > 0` }]] }] }, ro);
        expect(res.status).toBe(403);
        expect(res.error).toContain("READ ONLY transaction");
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 0 }]);
      });

      it("refuses a changeset before anything runs", async () => {
        const res = await apply({ table: "people", updates: [{ key: { id: 1 }, set: { name: "A" } }] }, ro);
        expect(res.status).toBe(403);
        expect(await rows(`SELECT name FROM ${DB}.people WHERE id = 1`)).toEqual([{ name: "a" }]);
      });
    });

    describe("ppm db", () => {
      let c: ReturnType<typeof cli>;
      beforeEach(() => { c = cli(); });
      afterEach(() => c.restore());

      it("adds a connection and lists its tables", async () => {
        const name = `${engine.type}-cli-${RUN}`;
        await c.run("add", "-n", name, "-t", engine.type, "-c", url);
        expect(c.out.join("\n")).toContain(`Added connection: ${name} (${engine.type})`);
        expect(c.out.join("\n")).not.toContain("driver is not installed");
        await c.run("tables", name, "--json");
        const tables = JSON.parse(c.out.at(-1)!) as { schema: string; name: string }[];
        expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["users", "people", "employees"]));
        expect(tables.every((t) => t.schema === DB)).toBe(true);
        await c.run("schema", name, "people", "--json");
        expect((JSON.parse(c.out.at(-1)!) as { name: string }[]).map((col) => col.name)).toEqual(["id", "name", "age"]);
      });

      it("is refused by the server on a readonly connection", async () => {
        await expect(c.run("query", String(ro), `SELECT ${DB}.bump()`)).rejects.toThrow("exit 1");
        expect(c.errors.join("\n")).toContain("READ ONLY transaction");
        expect(await rows(`SELECT n FROM ${DB}.counter`)).toEqual([{ n: 0 }]);
        expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ source: "cli", status: "blocked" });
      });

      it("runs a script file with DELIMITER blocks statement by statement", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ppm-mysql-script-"));
        try {
          const file = join(dir, "script.sql");
          writeFileSync(file, [
            "DELIMITER //",
            "CREATE PROCEDURE add_person(IN p INT) BEGIN INSERT INTO people VALUES (p, 'x', NULL); INSERT INTO people VALUES (p + 1, 'y', NULL); END //",
            "DELIMITER ;",
            "CALL add_person(7);",
            "DROP PROCEDURE add_person;",
          ].join("\n"));
          await c.run("run", String(rw), file);
          expect(c.out.join("\n")).toContain("3 statement(s) executed");
          expect(await rows(`SELECT id FROM ${DB}.people WHERE id >= 7 ORDER BY id`)).toEqual([{ id: 7 }, { id: 8 }]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    describe("without the driver", () => {
      afterEach(() => installDbDriver("mysql", { run: copyingRunner("mysql") }));

      it("answers 424 naming the driver, and still serves the cached table list", async () => {
        await uninstallDbDriver("mysql");
        const res = await grid({ table: "people" });
        expect(res.status).toBe(424);
        const body = res.json as unknown as DbDriverMissingBody;
        expect(body).toMatchObject({ ok: false, code: "DB_DRIVER_MISSING", driver: { id: "mysql", displayName: "MySQL / MariaDB" } });
        expect(body.error).toContain("ppm db driver install mysql");

        const test = await call("POST", "/db/test", { type: engine.type, connectionConfig: { type: engine.type, connectionString: url } });
        expect(test.status).toBe(424);
        expect((await call("GET", `/db/connections/${rw}/tables?cached=1`)).status).toBe(200);
        // Editing the connection itself needs no driver.
        expect((await call("PUT", `/db/connections/${rw}`, { color: "#3b82f6" })).status).toBe(200);
      });

      it("tells ppm db add how to install it", async () => {
        await uninstallDbDriver("mysql");
        const c = cli();
        try {
          await c.run("add", "-n", `${engine.type}-nodriver-${RUN}`, "-t", engine.type, "-c", url);
        } finally {
          c.restore();
        }
        expect(c.out.join("\n")).toContain("The MySQL / MariaDB driver is not installed yet. Run: ppm db driver install mysql");
      });
    });
  });
}
