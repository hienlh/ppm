/**
 * Import's job against real servers: uploaded files into tables, each value into the type of the
 * column it goes to — the place where a driver serializing by the server's type misreads a text
 * (postgres.js and bool, json, bytea) — one transaction a file, Stop, and on MySQL and MariaDB
 * the table change that DDL's own commit keeps. Runs only when the servers are given, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *   bun test tests/integration/database-import-jobs.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import mysql2 from "mysql2/promise";
import postgres from "postgres";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import type { GridTarget } from "../../src/services/database/grid.service.ts";
import { createJob, resetJobs, stopJob, type ImpExpJob } from "../../src/services/database/impexp/impexp-job-store.ts";
import { parseExportJobRequest, parseImportJobRequest } from "../../src/services/database/impexp/impexp-request.ts";
import { runExportJob } from "../../src/services/database/impexp/export-job-runner.ts";
import { runImportJob } from "../../src/services/database/impexp/import-job-runner.ts";
import { resetUploads, saveUpload } from "../../src/services/database/impexp/import-uploads.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { postgresService } from "../../src/services/postgres.service.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PG_URL = process.env.PPM_TEST_PG_URL;
const MYSQL_ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

interface FileSpec {
  name: string;
  text: string;
  target: string;
  action: "createTable" | "appendData" | "truncate" | "dropCreateTable";
}

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** Uploads `files` and runs one job of them to its end; `onStart` sees the job while it runs. */
async function importFiles(
  target: GridTarget, schema: string | null, format: "csv" | "json" | "jsonl", files: FileSpec[], onStart?: (job: ImpExpJob) => void,
): Promise<ImpExpJob> {
  const uploaded = [];
  for (const f of files) {
    const upload = await saveUpload(f.name, bytes(f.text), new AbortController().signal);
    uploaded.push({ upload: upload.id, source: f.name.replace(/\.[^.]+$/, ""), target: f.target, action: f.action });
  }
  const plan = parseImportJobRequest({ format, schema, files: uploaded }, target.type, schema);
  const job = await createJob("import", plan.items.map((i) => ({ source: i.source, target: i.target })));
  const running = runImportJob(job, plan, { target, auditItem: () => ({ ended() {} }) });
  onStart?.(job);
  await running;
  return job;
}

/** Stops `job` once its first rows have been read. */
function stopOnceReading(job: ImpExpJob): void {
  const poll = (): void => {
    if (job.items[0]!.rowsRead > 0) stopJob(job);
    else setTimeout(poll, 1);
  };
  poll();
}

const messages = (job: ImpExpJob) => job.messages.map((m) => `${m.level}: ${m.text}`);

/** `read` once it answers `want`, or what it answers after two seconds: a closed connection's backend ends a moment later. */
async function settled<T>(read: () => Promise<T>, want: T): Promise<T> {
  const until = Date.now() + 2_000;
  for (;;) {
    const got = await read();
    if (got === want || Date.now() > until) return got;
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  initAdapters();
  if (MYSQL_ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterEach(async () => {
  resetJobs();
  await resetUploads();
});

afterAll(async () => {
  await postgresService.closeAll();
  await mysqlService.closeAll();
  await readonlyMysqlService.closeAll();
});

describe.skipIf(!PG_URL)("import on Postgres", () => {
  const S = `ppm_import_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const target = (): GridTarget => ({ type: "postgres", adapter: getAdapter("postgres"), config: { type: "postgres", connectionString: PG_URL!, readonly: false } });
  const rows = (sql: string) => admin!.unsafe(sql) as Promise<Record<string, unknown>[]>;
  const openTransactions = async () => Number((await admin!`
    SELECT COUNT(*)::int AS n FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND datname = current_database() AND xact_start IS NOT NULL`)[0]!.n);

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${S}`);
    await admin!.unsafe(`CREATE TABLE ${S}.typed (
      id serial PRIMARY KEY, flag boolean, doc jsonb, raw bytea, born date, at timestamptz,
      amount numeric(30,10), tags text[], big bigint, twice bigint GENERATED ALWAYS AS (big * 2) STORED
    )`);
    await admin!.unsafe(`CREATE TABLE ${S}.parent (id integer PRIMARY KEY)`);
    await admin!.unsafe(`CREATE TABLE ${S}.child (id integer PRIMARY KEY, parent_id integer REFERENCES ${S}.parent(id))`);
    await admin!.unsafe(`INSERT INTO ${S}.parent VALUES (1)`);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin!.end();
  });

  it("creates a table of text columns from a CSV, keeping NULL apart from the empty string", async () => {
    const job = await importFiles(target(), S, "csv", [{ name: "people.csv", text: 'id,name,note\n1,Ann,""\n2,,x\n', target: "people", action: "createTable" }]);
    expect(job.state).toBe("done");
    expect(await rows(`SELECT id, name, note FROM ${S}.people ORDER BY id`)).toEqual([{ id: "1", name: "Ann", note: "" }, { id: "2", name: null, note: "x" }]);
    expect(await rows(`SELECT DISTINCT data_type FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'people'`)).toEqual([{ data_type: "text" }]);
  });

  it("writes JSON values into the types of the columns they go to, exactly", async () => {
    const json = JSON.stringify([
      { flag: true, doc: { a: [1, 2] }, raw: { $binary: "AP8=", size: 2 }, born: "2024-02-29", at: "2024-01-01T10:00:00+07:00", tags: ["a,b", 'say "hi"'], twice: 5 },
      { flag: "false", doc: "just text", raw: "AQI=", born: null, at: null, amount: "-1.5", tags: null, big: "-42" },
    ]).replace('"twice":5', '"amount":12345678901234567890.0123456789,"big":9007199254740993,"twice":5');
    const job = await importFiles(target(), S, "json", [{ name: "typed.json", text: json, target: "typed", action: "appendData" }]);
    expect(job.state).toBe("done");
    expect(messages(job)).toContain("warning: typed: twice is computed by the database: left out");
    expect(await rows(`SELECT flag, doc::text AS doc, encode(raw, 'hex') AS raw, born::text AS born, (at AT TIME ZONE 'UTC')::text AS at,
      amount::text AS amount, tags, big::text AS big, twice::text AS twice FROM ${S}.typed ORDER BY id`)).toEqual([
      { flag: true, doc: '{"a": [1, 2]}', raw: "00ff", born: "2024-02-29", at: "2024-01-01 03:00:00", amount: "12345678901234567890.0123456789", tags: ["a,b", 'say "hi"'], big: "9007199254740993", twice: "18014398509481986" },
      { flag: false, doc: '"just text"', raw: "0102", born: null, at: null, amount: "-1.5000000000", tags: null, big: "-42", twice: "-84" },
    ]);
  });

  it("reads a CSV field as the column's own text: t/f, a JSON document, base64 bytes, an array literal", async () => {
    const csv = 'flag,doc,raw,tags\nt,"{""k"": 1}",AP8=,"{x,y}"\nno,[],,"[""p"",""q""]"\n';
    await admin!.unsafe(`TRUNCATE ${S}.typed`);
    const job = await importFiles(target(), S, "csv", [{ name: "typed.csv", text: csv, target: "typed", action: "appendData" }]);
    expect(job.state).toBe("done");
    expect(await rows(`SELECT flag, doc::text AS doc, encode(raw, 'hex') AS raw, tags FROM ${S}.typed ORDER BY id`)).toEqual([
      { flag: true, doc: '{"k": 1}', raw: "00ff", tags: ["x", "y"] },
      { flag: false, doc: "[]", raw: null, tags: ["p", "q"] },
    ]);
  });

  it("reads back what Export wrote, cell for cell, through CSV and through JSON", async () => {
    await admin!.unsafe(`CREATE TABLE ${S}.trip (
      id int PRIMARY KEY, s text, e text, big bigint, at timestamptz, raw bytea, amount numeric(30,10), flag boolean, doc jsonb
    )`);
    await admin!.unsafe(`INSERT INTO ${S}.trip VALUES
      (1, NULL, '', 9007199254740993, '2024-02-29 23:59:59.123456+07', '\\x00ff10', 12345678901234567890.0123456789, true, '{"a": [1, "x"]}'),
      (2, 'a,b "q"', NULL, -9223372036854775808, NULL, '\\x', NULL, false, '"just text"'),
      (3, E'line\\nbreak', ' ', NULL, 'infinity', NULL, -0.5, NULL, '12345678901234567890'),
      (4, '', 'NULL', 0, '1970-01-01 00:00:00+00', NULL, 0, true, '"123"')`);
    for (const format of ["csv", "json"] as const) {
      const plan = parseExportJobRequest({ format, source: { type: "database", schema: S, tables: [{ name: "trip", target: `trip.${format}` }] } }, S);
      const exported = await createJob("export", plan.items.map((i) => ({ source: i.source, target: i.target })));
      await runExportJob(exported, plan, { target: target(), auditItem: () => ({ rows() {}, ended() {} }) });
      expect(exported.state).toBe("done");
      await admin!.unsafe(`CREATE TABLE ${S}.trip_${format} (LIKE ${S}.trip INCLUDING ALL)`);
      const text = await Bun.file(exported.files[0]!.path).text();
      const job = await importFiles(target(), S, format, [{ name: `trip.${format}`, text, target: `trip_${format}`, action: "appendData" }]);
      expect(messages(job).filter((m) => !m.startsWith("info:"))).toEqual([]);
      expect(await rows(`SELECT COUNT(*)::int AS n FROM (
        (TABLE ${S}.trip EXCEPT TABLE ${S}.trip_${format}) UNION ALL (TABLE ${S}.trip_${format} EXCEPT TABLE ${S}.trip)) d`)).toEqual([{ n: 0 }]);
    }
  });

  it("rolls back a whole file on a failing row, the rows Truncate deleted included", async () => {
    await admin!.unsafe(`TRUNCATE ${S}.typed; INSERT INTO ${S}.typed (born) VALUES ('2000-01-01')`);
    const job = await importFiles(target(), S, "csv", [{ name: "bad.csv", text: "born\n2024-01-01\n2024-01-02\nnot a date\n", target: "typed", action: "truncate" }]);
    expect(job.state).toBe("error");
    expect(job.items[0]!.error).toMatch(/invalid input syntax for type date/);
    expect(await rows(`SELECT born::text AS born FROM ${S}.typed`)).toEqual([{ born: "2000-01-01" }]);
    expect(messages(job)).toContain(`info: bad: rolled back, ${S}.typed holds none of the file's rows`);
    expect(await settled(openTransactions, 0)).toBe(0);
  });

  it("keeps the table Drop and create would have replaced when the file fails to read", async () => {
    const job = await importFiles(target(), S, "csv", [{ name: "cut.csv", text: 'x\n1\n"never closed\n', target: "typed", action: "dropCreateTable" }]);
    expect(job.items[0]!.error).toBe("Line 3 opens a quoted field that never ends");
    expect(await rows(`SELECT born::text AS born FROM ${S}.typed`)).toEqual([{ born: "2000-01-01" }]);
  });

  it("refuses to drop a table another one points at, in Postgres's own words", async () => {
    const job = await importFiles(target(), S, "csv", [{ name: "p.csv", text: "id\n5\n", target: "parent", action: "dropCreateTable" }]);
    expect(job.items[0]!.error).toMatch(/cannot drop table .*parent because other objects depend on it/);
    expect(await rows(`SELECT id FROM ${S}.parent`)).toEqual([{ id: 1 }]);
  });

  it("Truncate and import, Drop and create table, and Append data into a table that is not there", async () => {
    await admin!.unsafe(`CREATE TABLE ${S}.acts (id int, name text, extra int); INSERT INTO ${S}.acts VALUES (9, 'old', 1)`);
    const file = (action: FileSpec["action"], into = "acts"): FileSpec => ({ name: "acts.csv", text: "id,name\n1,a\n2,b\n", target: into, action });
    expect((await importFiles(target(), S, "csv", [file("truncate")])).state).toBe("done");
    expect(await rows(`SELECT id, name, extra FROM ${S}.acts ORDER BY id`)).toEqual([{ id: 1, name: "a", extra: null }, { id: 2, name: "b", extra: null }]);
    expect((await importFiles(target(), S, "csv", [file("dropCreateTable")])).state).toBe("done");
    expect(await rows(`SELECT column_name AS c, data_type AS t FROM information_schema.columns
      WHERE table_schema = '${S}' AND table_name = 'acts' ORDER BY ordinal_position`)).toEqual([{ c: "id", t: "text" }, { c: "name", t: "text" }]);
    expect(await rows(`SELECT id, name FROM ${S}.acts ORDER BY id`)).toEqual([{ id: "1", name: "a" }, { id: "2", name: "b" }]);
    const missing = await importFiles(target(), S, "csv", [file("appendData", "nowhere")]);
    expect([missing.state, missing.items[0]!.error]).toEqual(["error", `Table ${S}.nowhere not found`]);
  });

  it("writes a file of many rows in statements under the parameter limit", async () => {
    // 65 533 parameters a statement: 21 844 rows of three columns.
    const text = `a,b,c\n${Array.from({ length: 50_000 }, (_, i) => `${i},b${i},${"c".repeat(i % 100)}`).join("\n")}\n`;
    const job = await importFiles(target(), S, "csv", [{ name: "many.csv", text, target: "many", action: "createTable" }]);
    expect(job.items[0]).toMatchObject({ state: "done", rowsRead: 50_000, rowsWritten: 50_000 });
    expect(await rows(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT a)::int AS d FROM ${S}.many`)).toEqual([{ n: 50_000, d: 50_000 }]);
  });

  it("Stop cancels the INSERT running and keeps nothing of the file, its new table included", async () => {
    const text = `a,b\n${Array.from({ length: 300_000 }, (_, i) => `${i},row ${i}`).join("\n")}\n`;
    const job = await importFiles(target(), S, "csv", [{ name: "big.csv", text, target: "big", action: "createTable" }], stopOnceReading);
    expect(job.state).toBe("stopped");
    expect(job.items[0]).toMatchObject({ state: "stopped", rowsWritten: 0 });
    expect(await rows(`SELECT to_regclass('${S}.big') AS t`)).toEqual([{ t: null }]);
    expect(await settled(openTransactions, 0)).toBe(0);
  });
});

for (const engine of MYSQL_ENGINES) {
  describe.skipIf(!engine.url)(`import on ${engine.type}`, () => {
    const DB = `ppm_import_${engine.type}_${RUN}`;
    const url = `${engine.url?.replace(/\/$/, "")}/${DB}`;
    const target = (): GridTarget => ({ type: engine.type, adapter: getAdapter(engine.type), config: { type: engine.type, connectionString: url, readonly: false } });
    const engineName = engine.type === "mysql" ? "MySQL" : "MariaDB";
    let admin: mysql2.Connection;
    const rows = async (sql: string) => (await admin.query(sql))[0] as Record<string, unknown>[];

    beforeAll(async () => {
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:"), dateStrings: true });
      await admin.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4`);
      await admin.query(`CREATE TABLE ${DB}.typed (
        id INT AUTO_INCREMENT PRIMARY KEY, flag BOOLEAN, doc JSON, raw BLOB, born DATE, at DATETIME,
        amount DECIMAL(30,10), big BIGINT, twice BIGINT AS (big * 2) VIRTUAL
      )`);
    });

    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    });

    it("creates a table of LONGTEXT columns from a CSV, keeping NULL apart from the empty string", async () => {
      const job = await importFiles(target(), null, "csv", [{ name: "people.csv", text: 'id,name,note\n1,Ann,""\n2,,x\n', target: "people", action: "createTable" }]);
      expect(job.state).toBe("done");
      expect(await rows(`SELECT id, name, note FROM ${DB}.people ORDER BY id`)).toEqual([{ id: "1", name: "Ann", note: "" }, { id: "2", name: null, note: "x" }]);
      expect(await rows(`SELECT DISTINCT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'people'`)).toEqual([{ t: "longtext" }]);
    });

    it("writes JSON values into the types of the columns they go to, exactly", async () => {
      const json = '[{"flag":true,"doc":{"a":[1,2]},"raw":{"$binary":"AP8=","size":2},"born":"2024-02-29","at":"2024-01-01 10:00:00",'
        + '"amount":12345678901234567890.0123456789,"big":9007199254740993,"twice":5},'
        + '{"flag":"false","doc":"just text","raw":"AQI=","born":null,"at":null,"amount":"-1.5","big":"-42"}]';
      const job = await importFiles(target(), null, "json", [{ name: "typed.json", text: json, target: "typed", action: "appendData" }]);
      expect(messages(job).filter((m) => m.startsWith("error"))).toEqual([]);
      expect(job.state).toBe("done");
      expect(messages(job)).toContain("warning: typed: twice is computed by the database: left out");
      const got = await rows(`SELECT flag, CAST(doc AS CHAR) AS doc, HEX(raw) AS raw, born, at, CAST(amount AS CHAR) AS amount,
        CAST(big AS CHAR) AS big, CAST(twice AS CHAR) AS twice FROM ${DB}.typed ORDER BY id`);
      // MySQL keeps JSON parsed and prints it its own way; MariaDB keeps the text as written.
      expect(got.map((r) => ({ ...r, doc: JSON.parse(r.doc as string) }))).toEqual([
        { flag: 1, doc: { a: [1, 2] }, raw: "00FF", born: "2024-02-29", at: "2024-01-01 10:00:00", amount: "12345678901234567890.0123456789", big: "9007199254740993", twice: "18014398509481986" },
        { flag: 0, doc: "just text", raw: "0102", born: null, at: null, amount: "-1.5000000000", big: "-42", twice: "-84" },
      ]);
    });

    it(`keeps the rows Truncate deleted when a row fails, since ${engine.type} commits TRUNCATE at once — and says so`, async () => {
      await admin.query(`INSERT INTO ${DB}.typed (born) VALUES ('2000-01-01')`);
      const job = await importFiles(target(), null, "csv", [{ name: "bad.csv", text: "born\n2024-01-01\nnot a date\n", target: "typed", action: "truncate" }]);
      expect(job.state).toBe("error");
      expect(job.items[0]!.error).toMatch(/Incorrect date value/);
      expect(await rows(`SELECT COUNT(*) AS n FROM ${DB}.typed`)).toEqual([{ n: 0 }]);
      expect(messages(job)).toContain(`warning: bad: ${engineName} commits table changes at once, so "Deleting the rows of typed" is kept even if writing the rows fails`);
      expect(messages(job)).toContain(`info: bad: rolled back, typed holds none of the file's rows (the table change ${engineName} committed stays)`);
    });

    it("Truncate and import, Drop and create table, and Append data into a table that is not there", async () => {
      await admin.query(`CREATE TABLE ${DB}.acts (id INT, name TEXT, extra INT)`);
      await admin.query(`INSERT INTO ${DB}.acts VALUES (9, 'old', 1)`);
      const file = (action: FileSpec["action"], into = "acts"): FileSpec => ({ name: "acts.csv", text: "id,name\n1,a\n2,b\n", target: into, action });
      expect((await importFiles(target(), null, "csv", [file("truncate")])).state).toBe("done");
      expect(await rows(`SELECT id, name, extra FROM ${DB}.acts ORDER BY id`)).toEqual([{ id: 1, name: "a", extra: null }, { id: 2, name: "b", extra: null }]);
      expect((await importFiles(target(), null, "csv", [file("dropCreateTable")])).state).toBe("done");
      expect(await rows(`SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'acts' ORDER BY ORDINAL_POSITION`)).toEqual([{ c: "id", t: "longtext" }, { c: "name", t: "longtext" }]);
      expect(await rows(`SELECT id, name FROM ${DB}.acts ORDER BY id`)).toEqual([{ id: "1", name: "a" }, { id: "2", name: "b" }]);
      const missing = await importFiles(target(), null, "csv", [file("appendData", "nowhere")]);
      expect([missing.state, missing.items[0]!.error]).toEqual(["error", "Table nowhere not found"]);
    });

    it("writes a file of many rows in statements under the parameter and packet limits", async () => {
      // Short rows fill a statement's placeholders first, long ones its bytes.
      const narrow = `a,b,c\n${Array.from({ length: 50_000 }, (_, i) => `${i},b,c`).join("\n")}\n`;
      const wide = `a,b,c\n${Array.from({ length: 30_000 }, (_, i) => `${i},b${i},${"c".repeat(200)}`).join("\n")}\n`;
      const job = await importFiles(target(), null, "csv", [
        { name: "narrow.csv", text: narrow, target: "narrow", action: "createTable" },
        { name: "wide.csv", text: wide, target: "wide", action: "createTable" },
      ]);
      expect(job.items.map((i) => [i.state, i.rowsWritten])).toEqual([["done", 50_000], ["done", 30_000]]);
      expect(await rows(`SELECT (SELECT COUNT(*) FROM ${DB}.narrow) AS n, (SELECT COUNT(*) FROM ${DB}.wide) AS w`)).toEqual([{ n: 50_000, w: 30_000 }]);
    });

    it("Stop kills the INSERT running and keeps none of the rows; the CREATE it committed stays", async () => {
      const text = `a,b\n${Array.from({ length: 300_000 }, (_, i) => `${i},row ${i}`).join("\n")}\n`;
      const job = await importFiles(target(), null, "csv", [{ name: "big.csv", text, target: "big", action: "createTable" }], stopOnceReading);
      expect(job.state).toBe("stopped");
      expect(job.items[0]).toMatchObject({ state: "stopped", rowsWritten: 0 });
      expect(await rows(`SELECT COUNT(*) AS n FROM ${DB}.big`)).toEqual([{ n: 0 }]);
    });
  });
}
