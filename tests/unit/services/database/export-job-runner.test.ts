/**
 * Export advanced's job on a real SQLite file: rows read a table at a time into files, Configure
 * columns applied, the first failing row ending the job with the rest Queued, Stop, a query as the
 * source, Create single file and the zip. The files land in a PPM directory of the test's own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { getAdapter } from "../../../../src/services/database/adapter-registry.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { readonlySqliteService, sqliteService } from "../../../../src/services/sqlite.service.ts";
import type { GridTarget } from "../../../../src/services/database/grid.service.ts";
import { runExportJob, type ExportItemAudit } from "../../../../src/services/database/impexp/export-job-runner.ts";
import { createJob, resetJobs, stopJob, type ImpExpJob } from "../../../../src/services/database/impexp/impexp-job-store.ts";
import { parseExportJobRequest, type ExportItemPlan, type ExportJobPlan } from "../../../../src/services/database/impexp/impexp-request.ts";
import { zipFiles } from "../../../../src/services/database/impexp/zip-output.ts";
import type { StreamRowsOptions } from "../../../../src/types/database.ts";
import { DEFAULT_EXPORT_OPTIONS, type ExportFormatOptions } from "../../../../src/shared/db-impexp.ts";
import { readZip } from "../../../helpers/read-zip.ts";

const originalPpmHome = process.env.PPM_HOME;
const tempDirs: string[] = [];
let dbPath: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seed(): string {
  const path = join(tempDir("ppm-impexp-db-"), "data.db");
  const db = new Database(path);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  db.exec("INSERT INTO users VALUES (1, 'Ann', 'ann@x.io'), (2, 'Bob', NULL), (3, '', 'c@x.io')");
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)");
  db.exec("INSERT INTO orders VALUES (1, 9.5), (2, 20)");
  db.exec("CREATE TABLE many (id INTEGER PRIMARY KEY, label TEXT)");
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) INSERT INTO many SELECT i, 'row ' || i FROM n");
  db.exec("CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 10");
  db.close();
  return path;
}

const target = (): GridTarget => ({ type: "sqlite", adapter: getAdapter("sqlite"), config: { type: "sqlite", path: dbPath, readonly: false } });

interface AuditEntry { source: string; sql: string; error: string | null; rowCount: number; rows: unknown[][] }

function plan(body: Record<string, unknown>): ExportJobPlan {
  return parseExportJobRequest({ format: "csv", options: DEFAULT_EXPORT_OPTIONS, ...body }, null);
}

const options = (over: Partial<ExportFormatOptions>): ExportFormatOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...over });

async function run(p: ExportJobPlan, onRows?: (job: ImpExpJob) => void, on: GridTarget = target()): Promise<{ job: ImpExpJob; audits: AuditEntry[] }> {
  const job = await createJob("export", p.items);
  const audits: AuditEntry[] = [];
  await runExportJob(job, p, {
    target: on,
    limits: { rows: 500, bytes: 1 << 20 },
    auditItem(item: ExportItemPlan): ExportItemAudit {
      const rows: unknown[][] = [];
      return {
        rows(_columns, batch) {
          rows.push(...batch);
          onRows?.(job);
        },
        ended(sql, error, rowCount) {
          audits.push({ source: item.source, sql, error, rowCount, rows });
        },
      };
    },
  });
  return { job, audits };
}

/** The descriptors this process holds on `path`, read from /proc: Linux only. */
function openOn(path: string): number {
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === path;
    } catch {
      return false;
    }
  }).length;
}

const fileText = (job: ImpExpJob, name: string): string => readFileSync(job.files.find((f) => f.name === name)!.path, "utf8");

beforeEach(() => {
  process.env.PPM_HOME = tempDir("ppm-impexp-home-");
  _resetPpmDir();
  initAdapters();
  dbPath = seed();
});

afterEach(() => {
  resetJobs();
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  // Every test's file stays open in PPM's cache, and Windows deletes no file that is open.
  sqliteService.closeAll();
  readonlySqliteService.closeAll();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("tables into files", () => {
  it("writes each table into its own file, in order, and ends Done with every row counted", async () => {
    const { job, audits } = await run(plan({ source: { type: "database", tables: [
      { name: "users", target: "users.csv" }, { name: "orders", target: "orders.csv" },
    ] } }));
    expect(job.state).toBe("done");
    expect(job.items.map((i) => [i.source, i.state, i.rowsRead, i.rowsWritten])).toEqual([["users", "done", 3, 3], ["orders", "done", 2, 2]]);
    expect(fileText(job, "users.csv")).toBe('id,name,email\n1,Ann,ann@x.io\n2,Bob,\n3,"",c@x.io\n');
    expect(fileText(job, "orders.csv")).toBe("id,total\n1,9.5\n2,20\n");
    expect(job.files.map((f) => [f.name, f.size])).toEqual([["users.csv", 48], ["orders.csv", 20]]);
    for (const f of job.files) expect(readFileSync(f.path).byteLength).toBe(f.size);
    expect(job.messages.map((m) => m.text)).toEqual([
      "Reading users", "Writing file users.csv", "Reading orders", "Writing file orders.csv", "Finished job",
    ]);
    expect(audits.map((a) => [a.source, a.error, a.rowCount])).toEqual([["users", null, 3], ["orders", null, 2]]);
    expect(audits[0]!.sql).toBe('SELECT "id", "name", "email"\nFROM "users"');
  });

  it("shows a row Running while it is read, and the rows after it Queued", async () => {
    const seen: string[][] = [];
    await run(plan({ source: { type: "database", tables: [{ name: "users", target: "u.csv" }, { name: "orders", target: "o.csv" }] } }), (j) => {
      seen.push(j.items.map((i) => i.state));
    });
    expect(seen[0]).toEqual(["running", "queued"]);
  });

  it("names the schema it reads from", async () => {
    const { job } = await run(plan({ source: { type: "database", schema: "main", tables: [{ name: "orders", target: "o.csv" }] } }));
    expect(job.state).toBe("done");
    expect(job.messages[0]!.text).toBe("Reading main.orders");
  });

  it("keeps each file under a name of the server's own, inside the job's folder", async () => {
    const { job } = await run(plan({ source: { type: "database", tables: [{ name: "users", target: "my users.csv" }] } }));
    const file = job.files[0]!;
    expect(file.name).toBe("my users.csv");
    expect(dirname(file.path)).toBe(job.dir!);
    expect(readdirSync(job.dir!)).toEqual(["0"]);
  });

  it("reads a view as it reads a table", async () => {
    const { job } = await run(plan({ source: { type: "database", tables: [{ name: "big_orders", target: "big.csv" }] } }));
    expect(job.state).toBe("done");
    expect(fileText(job, "big.csv")).toBe("id,total\n2,20\n");
  });

  it("applies Configure columns: order, names, and the columns left out", async () => {
    const { job, audits } = await run(plan({ source: { type: "database", tables: [{
      name: "users", target: "u.csv",
      columns: [{ src: "email", dst: "mail" }, { src: "name", dst: "name", skip: true }, { src: "id", dst: "user_id" }],
    }] } }));
    expect(fileText(job, "u.csv")).toBe("mail,user_id\nann@x.io,1\n,2\nc@x.io,3\n");
    // As written: SQLite's integers come as bigints, which keep a 64-bit key exact.
    expect(audits[0]!.rows).toEqual([["ann@x.io", 1n], [null, 2n], ["c@x.io", 3n]]);
  });

  it("writes each format with the options given", async () => {
    const { job } = await run(plan({
      format: "json",
      options: options({ json: { style: "object", keyField: "name", rootField: "users" } }),
      source: { type: "database", tables: [{ name: "users", target: "u.json" }] },
    }));
    expect(JSON.parse(fileText(job, "u.json"))).toEqual({
      users: { Ann: { id: 1, email: "ann@x.io" }, Bob: { id: 2, email: null }, "": { id: 3, email: "c@x.io" } },
    });
  });

  it("names a SQL file's table after the source table", async () => {
    const { job } = await run(plan({ format: "sql", source: { type: "database", tables: [{ name: "orders", target: "o.sql" }] } }));
    expect(fileText(job, "o.sql")).toBe('INSERT INTO "orders" ("id", "total") VALUES (1, 9.5);\nINSERT INTO "orders" ("id", "total") VALUES (2, 20);\n');
  });

  it("puts a file of its own on one sheet named Sheet 1, as DBGate does", async () => {
    const { job } = await run(plan({ format: "xlsx", source: { type: "database", tables: [{ name: "orders", target: "orders.xlsx" }] } }));
    const entries = readZip(readFileSync(job.files[0]!.path));
    expect(entries.get("xl/workbook.xml")!.toString()).toContain('<sheet name="Sheet 1"');
  });
});

describe("a row that fails, and Stop", () => {
  it("ends the job at the first row that fails: the rows before are Done, the rows after stay Queued", async () => {
    const { job, audits } = await run(plan({ source: { type: "database", tables: [
      { name: "users", target: "users.csv" }, { name: "missing", target: "missing.csv" }, { name: "orders", target: "orders.csv" },
    ] } }));
    expect(job.state).toBe("error");
    expect(job.items.map((i) => i.state)).toEqual(["done", "error", "queued"]);
    expect(job.items[1]!.error).toBe('Table "missing" not found');
    expect(job.files.map((f) => f.name)).toEqual(["users.csv"]);
    expect(readdirSync(job.dir!)).toEqual(["0"]);
    expect(job.messages.at(-1)).toMatchObject({ level: "error", text: 'missing: Table "missing" not found' });
    expect(audits.map((a) => [a.source, a.error])).toEqual([["users", null], ["missing", 'Table "missing" not found']]);
    expect(audits[1]!.sql).toBe('SELECT * FROM "missing"');
    expect(job.endedAt).not.toBeNull();
  });

  it("fails a row whose mapping names a column the table lacks, and leaves no file of it", async () => {
    const { job } = await run(plan({ source: { type: "database", tables: [{ name: "users", target: "u.csv", columns: [{ src: "phone", dst: "phone" }] }] } }));
    expect(job.items[0]).toMatchObject({ state: "error", error: 'Column "phone" is not in "users"' });
    expect(readdirSync(job.dir!)).toEqual([]);
  });

  it("Stop ends the read where it is, removes the file it was writing, and leaves the rows after it Queued", async () => {
    const { job, audits } = await run(
      plan({ source: { type: "database", tables: [{ name: "many", target: "many.csv" }, { name: "users", target: "users.csv" }] } }),
      (j) => stopJob(j),
    );
    expect(job.state).toBe("stopped");
    expect(job.items.map((i) => i.state)).toEqual(["stopped", "queued"]);
    expect(job.items[0]!.rowsRead).toBeGreaterThan(0);
    expect(job.items[0]!.rowsRead).toBeLessThan(200_000);
    expect(job.files).toEqual([]);
    expect(readdirSync(job.dir!)).toEqual([]);
    expect(audits[0]!.error).toMatch(/^Stopped after [\d,]+ rows$/);
    expect(job.messages.some((m) => m.level === "info" && /^many: stopped after [\d,]+ rows$/.test(m.text))).toBe(true);
  });
});

describe("a query", () => {
  it("writes the query's columns as the database describes them, a name given twice numbered", async () => {
    const { job, audits } = await run(plan({ source: { type: "query", sql: "SELECT u.id, o.id, u.name FROM users u JOIN orders o ON o.id = u.id", target: "q.csv" } }));
    expect(job.state).toBe("done");
    expect(fileText(job, "q.csv")).toBe("id,id_1,name\n1,1,Ann\n2,2,Bob\n");
    expect(job.messages[0]!.text).toBe("Reading query");
    expect(audits[0]!.sql).toBe("SELECT u.id, o.id, u.name FROM users u JOIN orders o ON o.id = u.id");
  });

  it("writes a file with its header even when the query finds no rows", async () => {
    const { job } = await run(plan({ source: { type: "query", sql: "SELECT id, name FROM users WHERE id < 0", target: "none.csv" } }));
    expect(fileText(job, "none.csv")).toBe("id,name\n");
  });

  it("names a SQL file's table after the file, without its extension", async () => {
    const { job } = await run(plan({ format: "sql", source: { type: "query", sql: "SELECT id FROM orders WHERE id = 1", target: "Totals.SQL" } }));
    expect(fileText(job, "Totals.SQL")).toBe('INSERT INTO "Totals" ("id") VALUES (1);\n');
    // A file named only by its extension keeps that as the table's name, not an empty one.
    const bare = await run(plan({ format: "sql", source: { type: "query", sql: "SELECT id FROM orders WHERE id = 1", target: ".sql" } }));
    expect(fileText(bare.job, ".sql")).toBe('INSERT INTO ".sql" ("id") VALUES (1);\n');
  });

  it("fails with the database's own error", async () => {
    const { job } = await run(plan({ source: { type: "query", sql: "SELECT nope FROM users", target: "q.csv" } }));
    expect(job.items[0]!.state).toBe("error");
    expect(job.items[0]!.error).toContain("no such column: nope");
  });
});

describe("a read that ends badly", () => {
  /** The query source read through a stand-in for the driver, which `rows` plays. */
  const fake = (rows: (opts: StreamRowsOptions) => AsyncGenerator<unknown[][]>): GridTarget => ({
    ...target(),
    adapter: { streamRows: (_config: unknown, _stmt: unknown, _limits: unknown, opts: StreamRowsOptions) => rows(opts) } as never,
  });
  const query = (columns?: unknown) => plan({ source: { type: "query", sql: "SELECT 1", target: "q.csv", ...(columns ? { columns } : {}) } });

  it("fails a statement that gives no result to export", async () => {
    const { job } = await run(query(), undefined, fake(async function* () {}));
    expect(job.items[0]).toMatchObject({ state: "error", error: "The statement gives no result to export" });
  });

  it("says the export failed when the error says nothing", async () => {
    const { job } = await run(query(), undefined, fake(async function* () {
      throw new Error("");
    }));
    expect(job.items[0]).toMatchObject({ state: "error", error: "The export failed" });
  });

  it("ends the read when the mapping does not fit what the statement found", async () => {
    let ended = false;
    const { job } = await run(query([{ src: "nope", dst: "nope" }]), undefined, fake(async function* (opts) {
      try {
        opts.onColumns?.([{ name: "a", type: "text" }] as never);
        yield [["x"]];
        yield [["y"]];
      } finally {
        ended = true;
      }
    }));
    expect(job.items[0]).toMatchObject({ state: "error", error: `Column "nope" is not in the query's result` });
    expect(ended).toBe(true);
  });
});

describe("Create single file and the zip", () => {
  it("writes one data.xlsx with a sheet for each table, named after its row", async () => {
    const { job } = await run(plan({
      format: "xlsx",
      options: options({ xlsxSingleFile: true }),
      source: { type: "database", tables: [{ name: "users", target: "People" }, { name: "orders", target: "people" }] },
    }));
    expect(job.state).toBe("done");
    expect(job.items.map((i) => i.state)).toEqual(["done", "done"]);
    expect(job.files.map((f) => f.name)).toEqual(["data.xlsx"]);
    const workbook = readZip(readFileSync(job.files[0]!.path)).get("xl/workbook.xml")!.toString();
    expect([...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1])).toEqual(["People", "people_1"]);
  });

  it("keeps no workbook when a table fails, as it would miss that table", async () => {
    const { job } = await run(plan({
      format: "xlsx",
      options: options({ xlsxSingleFile: true }),
      source: { type: "database", tables: [{ name: "users", target: "u" }, { name: "missing", target: "m" }, { name: "orders", target: "o" }] },
    }));
    expect(job.state).toBe("error");
    expect(job.items.map((i) => i.state)).toEqual(["done", "error", "queued"]);
    expect(job.files).toEqual([]);
    expect(readdirSync(job.dir!)).toEqual([]);
    expect(job.messages.some((m) => m.level === "warning" && m.text.startsWith("data.xlsx was not kept"))).toBe(true);
  });

  it("puts every file into the zip under its row's name, and keeps only the zip", async () => {
    const { job } = await run(plan({
      zip: { name: "export" },
      source: { type: "database", tables: [{ name: "users", target: "users.csv" }, { name: "orders", target: "orders.csv" }] },
    }));
    expect(job.state).toBe("done");
    expect(job.files.map((f) => f.name)).toEqual(["export.zip"]);
    expect(readdirSync(job.dir!)).toEqual(["zip"]);
    const entries = readZip(readFileSync(job.files[0]!.path));
    expect([...entries.keys()]).toEqual(["users.csv", "orders.csv"]);
    expect(entries.get("orders.csv")!.toString()).toBe("id,total\n1,9.5\n2,20\n");
    expect(job.files[0]!.size).toBe(readFileSync(job.files[0]!.path).byteLength);
    expect(job.messages.some((m) => m.text.startsWith("ZIP file created ("))).toBe(true);
  });

  it("makes no zip when a row fails, and keeps the files written before it", async () => {
    const { job } = await run(plan({
      zip: { name: "export.zip" },
      source: { type: "database", tables: [{ name: "users", target: "users.csv" }, { name: "missing", target: "m.csv" }] },
    }));
    expect(job.state).toBe("error");
    expect(job.files.map((f) => f.name)).toEqual(["users.csv"]);
    expect(existsSync(join(job.dir!, "zip"))).toBe(false);
  });

  it("fails the zip of a file that is gone, rather than leave it out", async () => {
    const read = async (): Promise<void> => {
      for await (const _ of zipFiles([{ path: join(tempDir("ppm-zip-"), "gone"), name: "a.csv" }])) { /* read on */ }
    };
    await expect(read()).rejects.toThrow(/ENOENT|no such file/);
  });

  it("dates each file by the local clock, which is how zip tools read a zip's times", async () => {
    // A zip's time carries no zone. bun test runs in UTC, where local and UTC agree: a zone that
    // differs from it all year is what tells them apart.
    const savedZone = process.env.TZ;
    process.env.TZ = "Asia/Ho_Chi_Minh";
    try {
      const path = join(tempDir("ppm-zip-"), "a.csv");
      writeFileSync(path, "a\n");
      const before = Date.now();
      const chunks: Uint8Array[] = [];
      for await (const chunk of zipFiles([{ path, name: "a.csv" }])) chunks.push(chunk);
      const zip = Buffer.concat(chunks);
      const time = zip.readUInt16LE(10);
      const date = zip.readUInt16LE(12);
      const written = new Date((date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
      expect(Math.abs(written.getTime() - before)).toBeLessThan(10_000);
    } finally {
      // Assigned back, never deleted: after a delete Bun ignores every later assignment, and the
      // rest of the process would run in this zone.
      process.env.TZ = savedZone ?? "UTC";
    }
  });

  it.skipIf(process.platform !== "linux")("lets go of the file it was reading when the zip is not read to its end", async () => {
    const path = join(tempDir("ppm-zip-"), "big.bin");
    writeFileSync(path, randomBytes(8 << 20));
    const zip = zipFiles([{ path, name: "big.bin" }]);
    await zip.next();
    await Bun.sleep(30);
    expect(openOn(path)).toBeGreaterThan(0);
    await zip.return(undefined);
    await Bun.sleep(50);
    expect(openOn(path)).toBe(0);
  });
});
