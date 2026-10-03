/**
 * Import's writer against real servers: one transaction on a connection of its own, kept by a
 * commit and taken back by anything else; Stop cancelling the statement running; a readonly
 * connection refused. On MySQL and MariaDB DDL commits by itself, so the session opens its
 * transaction again after it. Runs only when the servers are given, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *   bun test tests/integration/database-write-session.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import mysql2 from "mysql2/promise";
import postgres from "postgres";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { ReadonlyViolationError } from "../../src/services/database/db-errors.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { postgresService } from "../../src/services/postgres.service.ts";
import type { DbConnectionConfig } from "../../src/types/database.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PG_URL = process.env.PPM_TEST_PG_URL;
const MYSQL_ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

beforeAll(async () => {
  initAdapters();
  if (MYSQL_ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  await postgresService.closeAll();
  await mysqlService.closeAll();
  await readonlyMysqlService.closeAll();
});

describe.skipIf(!PG_URL)("write session on Postgres", () => {
  const S = `ppm_write_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const config = (readonly = false): DbConnectionConfig => ({ type: "postgres", connectionString: PG_URL!, readonly });
  const tableExists = async (name: string) => (await admin!`SELECT to_regclass(${`${S}.${name}`}) AS t`)[0]!.t !== null;
  /** Sessions other than the admin's that are inside a transaction. */
  const openTransactions = async () => Number((await admin!`
    SELECT COUNT(*)::int AS n FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND datname = current_database() AND xact_start IS NOT NULL`)[0]!.n);

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${S}`);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin!.end();
  });

  it("keeps the table it created and its rows once committed", async () => {
    const session = await getAdapter("postgres").openWriteSession(config());
    expect(session.maxParams).toBe(65_533);
    await session.ddl(`CREATE TABLE ${S}.kept (a text, b boolean)`);
    expect(await session.run({ sql: `INSERT INTO ${S}.kept (a, b) VALUES ($1, CAST($2::text AS boolean)), ($3, NULL)`, params: ["1", "true", "2"] })).toBe(2);
    await session.commit();
    expect(await admin!.unsafe(`SELECT a, b FROM ${S}.kept ORDER BY a`)).toEqual([{ a: "1", b: true }, { a: "2", b: null }] as never);
    expect(await openTransactions()).toBe(0);
  });

  it("takes back the table and its rows when closed without a commit", async () => {
    const session = await getAdapter("postgres").openWriteSession(config());
    await session.ddl(`CREATE TABLE ${S}.gone (a text)`);
    await session.run({ sql: `INSERT INTO ${S}.gone (a) VALUES ($1)`, params: ["1"] });
    await session.close();
    await session.close();
    expect(await tableExists("gone")).toBe(false);
    expect(await openTransactions()).toBe(0);
  });

  it("Stop cancels the statement running, which then fails with Postgres's own error", async () => {
    const session = await getAdapter("postgres").openWriteSession(config());
    const running = session.run({ sql: "SELECT pg_sleep(30)", params: [] });
    await new Promise((r) => setTimeout(r, 200));
    session.cancel();
    await expect(running).rejects.toThrow(/canceling statement/);
    await session.close();
    expect(await openTransactions()).toBe(0);
  });

  it("ends with the connection's pools: close() leaves no transaction open", async () => {
    const session = await getAdapter("postgres").openWriteSession(config());
    await session.ddl(`CREATE TABLE ${S}.closed (a text)`);
    await getAdapter("postgres").close(config());
    await expect(session.run({ sql: `INSERT INTO ${S}.closed (a) VALUES ($1)`, params: ["1"] })).rejects.toThrow();
    await session.close();
    expect(await tableExists("closed")).toBe(false);
  });

  it("is refused on a readonly connection", async () => {
    await expect(getAdapter("postgres").openWriteSession(config(true))).rejects.toBeInstanceOf(ReadonlyViolationError);
  });
});

for (const engine of MYSQL_ENGINES) {
  describe.skipIf(!engine.url)(`write session on ${engine.type}`, () => {
    const DB = `ppm_write_${engine.type}_${RUN}`;
    const url = `${engine.url?.replace(/\/$/, "")}/${DB}`;
    const config = (readonly = false): DbConnectionConfig => ({ type: engine.type, connectionString: url, readonly });
    let admin: mysql2.Connection;
    const rows = async (sql: string) => (await admin.query(sql))[0] as Record<string, unknown>[];

    beforeAll(async () => {
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:") });
      await admin.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4`);
    });

    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    });

    it("opens its transaction again after DDL, which MySQL commits by itself", async () => {
      const session = await getAdapter(engine.type).openWriteSession(config());
      expect(session.maxParams).toBe(65_535);
      await session.ddl(`CREATE TABLE ${DB}.t1 (a TEXT)`);
      await session.run({ sql: `INSERT INTO ${DB}.t1 (a) VALUES (?), (?)`, params: ["1", "2"] });
      await session.close();
      // The CREATE TABLE stays — MySQL committed it — and the rows after it are taken back.
      expect(await rows(`SELECT COUNT(*) AS n FROM ${DB}.t1`)).toEqual([{ n: 0 }]);
    });

    it("keeps the rows a commit ends, and counts the rows each statement wrote", async () => {
      const session = await getAdapter(engine.type).openWriteSession(config());
      await session.ddl(`CREATE TABLE ${DB}.t2 (a TEXT, b TINYINT(1), c BLOB)`);
      expect(await session.run({ sql: `INSERT INTO ${DB}.t2 (a, b, c) VALUES (?, ?, ?), (?, ?, ?)`, params: ["x", 1, Buffer.from([0, 255]), null, 0, null] })).toBe(2);
      await session.commit();
      await session.close();
      expect(await rows(`SELECT a, b, HEX(c) AS c FROM ${DB}.t2 ORDER BY b DESC`)).toEqual([{ a: "x", b: 1, c: "00FF" }, { a: null, b: 0, c: null }]);
    });

    it("Stop kills the statement running from a second session", async () => {
      const session = await getAdapter(engine.type).openWriteSession(config());
      const running = session.run({ sql: "SELECT SLEEP(30)", params: [] });
      await new Promise((r) => setTimeout(r, 300));
      const started = Date.now();
      session.cancel();
      // A killed SLEEP() answers 1 rather than failing; either way it ends at once.
      await running.catch(() => 0);
      expect(Date.now() - started).toBeLessThan(5_000);
      await session.close();
    });

    it("is refused on a readonly connection", async () => {
      await expect(getAdapter(engine.type).openWriteSession(config(true))).rejects.toBeInstanceOf(ReadonlyViolationError);
    });
  });
}
