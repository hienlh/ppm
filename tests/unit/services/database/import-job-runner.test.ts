/**
 * Import's job on a real SQLite file, from files uploaded into a PPM directory of the test's own:
 * each action against a table that is or is not there, one transaction per file — a failing row
 * leaves its table as it was, and the files after it Queued — Stop, a file gone, Preview, and the
 * upload store's own limits.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { getAdapter } from "../../../../src/services/database/adapter-registry.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { readonlySqliteService, sqliteService } from "../../../../src/services/sqlite.service.ts";
import type { GridTarget } from "../../../../src/services/database/grid.service.ts";
import { IMPEXP_FILE_TTL_MS, importsDir } from "../../../../src/services/database/impexp/impexp-files.ts";
import { createJob, resetJobs, stopJob, type ImpExpJob } from "../../../../src/services/database/impexp/impexp-job-store.ts";
import { parseImportJobRequest, type ImportItemPlan, type ImportJobPlan } from "../../../../src/services/database/impexp/impexp-request.ts";
import { UPLOAD_GONE, previewUpload, runImportJob } from "../../../../src/services/database/impexp/import-job-runner.ts";
import {
  UploadError, holdUpload, isUploadId, removeUpload, resetUploads, saveUpload, sweepUploads, uploadNameProblem,
} from "../../../../src/services/database/impexp/import-uploads.ts";
import { IMPORT_MAX_FILE_BYTES } from "../../../../src/shared/db-impexp.ts";

const originalPpmHome = process.env.PPM_HOME;
const tempDirs: string[] = [];
let dbPath: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seed(): string {
  const path = join(tempDir("ppm-import-db-"), "data.db");
  const db = new Database(path);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, active BOOLEAN, avatar BLOB, score INTEGER CHECK (score >= 0))");
  db.exec("INSERT INTO users (name, email) VALUES ('Old', 'old@x.io')");
  db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
  db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)");
  db.exec("INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1)");
  db.exec("CREATE TABLE calc (a INTEGER, doubled INTEGER GENERATED ALWAYS AS (a * 2))");
  db.exec("CREATE VIEW user_names AS SELECT name FROM users");
  db.close();
  return path;
}

const target = (): GridTarget => ({ type: "sqlite", adapter: getAdapter("sqlite"), config: { type: "sqlite", path: dbPath, readonly: false } });

function query<T = Record<string, unknown>>(sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

async function* bytes(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part;
}

async function upload(name: string, text: string | Uint8Array): Promise<string> {
  return (await saveUpload(name, bytes(text), new AbortController().signal)).id;
}

interface AuditEntry { source: string; sql: string; error: string | null; rowCount: number }

function plan(format: string, files: Record<string, unknown>[], options: Record<string, unknown> = {}): ImportJobPlan {
  return parseImportJobRequest({ format, options, files }, "sqlite", null);
}

async function run(p: ImportJobPlan, onStart?: (job: ImpExpJob) => void, into: GridTarget = target()): Promise<{ job: ImpExpJob; audits: AuditEntry[] }> {
  const job = await createJob("import", p.items.map((i) => ({ source: i.source, target: i.target })));
  const audits: AuditEntry[] = [];
  const running = runImportJob(job, p, {
    target: into,
    auditItem: (item: ImportItemPlan) => ({ ended: (sql, error, rowCount) => audits.push({ source: item.source, sql, error, rowCount }) }),
  });
  onStart?.(job);
  await running;
  return { job, audits };
}

const items = (job: ImpExpJob) => job.items.map((i) => [i.source, i.state, i.rowsRead, i.rowsWritten]);
const messages = (job: ImpExpJob) => job.messages.map((m) => `${m.level}: ${m.text}`);

beforeEach(() => {
  process.env.PPM_HOME = tempDir("ppm-import-home-");
  _resetPpmDir();
  initAdapters();
  dbPath = seed();
});

afterEach(async () => {
  resetJobs();
  await resetUploads();
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

describe("files into tables", () => {
  it("creates a missing table with every file column as TEXT, keeping NULL apart from the empty string", async () => {
    const id = await upload("people.csv", 'id,name,note\n1,Ann,""\n2,,x\n');
    const { job, audits } = await run(plan("csv", [{ upload: id, source: "people", target: "people", action: "createTable" }]));
    expect(job.state).toBe("done");
    expect(items(job)).toEqual([["people", "done", 2, 2]]);
    expect(query("SELECT id, name, note, typeof(id) AS t FROM people ORDER BY id")).toEqual([
      { id: "1", name: "Ann", note: "", t: "text" },
      { id: "2", name: null, note: "x", t: "text" },
    ]);
    expect(messages(job)).toEqual([
      "info: Reading file people",
      "info: Creating table people",
      "info: Writing rows to people",
      "info: people: 2 rows written to people",
      "info: Finished job",
    ]);
    expect(audits).toEqual([{
      source: "people",
      sql: 'CREATE TABLE "people" (\n  "id" TEXT,\n  "name" TEXT,\n  "note" TEXT\n);\nINSERT INTO "people" ("id", "name", "note") VALUES (?, ?, ?)',
      error: null,
      rowCount: 2,
    }]);
    // The job let the upload go: Remove takes the file at once.
    await removeUpload(id);
    expect(readdirSync(importsDir())).toEqual([]);
  });

  it("appends into a table that exists: its own id is generated, a column it lacks is left out and said so", async () => {
    const id = await upload("u.csv", "name,email,nickname,active\nAnn,ann@x.io,annie,TRUE\nBob,,bobby,false\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "u", target: "users", action: "createTable" }]));
    expect(job.state).toBe("done");
    expect(query("SELECT id, name, email, active FROM users ORDER BY id")).toEqual([
      { id: 1, name: "Old", email: "old@x.io", active: null },
      { id: 2, name: "Ann", email: "ann@x.io", active: 1 },
      { id: 3, name: "Bob", email: null, active: 0 },
    ]);
    expect(messages(job)).toContain("warning: u: users has no column nickname: left out");
  });

  it("writes base64 or {\"$binary\": …} into a BLOB column as bytes, and big numbers exact", async () => {
    const csv = await upload("a.csv", "name,avatar,score\nA,AP8=,9007199254740993\n");
    const json = await upload("b.json", '[{"name":"B","avatar":{"$binary":"AQI=","size":2},"score":9007199254740995}]');
    await run(plan("csv", [{ upload: csv, source: "a", target: "users", action: "appendData" }]));
    await run(plan("json", [{ upload: json, source: "b", target: "users", action: "appendData" }]));
    const db = new Database(dbPath, { readonly: true, safeIntegers: true });
    const rows = db.query("SELECT name, hex(avatar) AS avatar, score FROM users WHERE id > 1 ORDER BY id").all();
    db.close();
    expect(rows).toEqual([{ name: "A", avatar: "00FF", score: 9007199254740993n }, { name: "B", avatar: "0102", score: 9007199254740995n }]);
  });

  it("reads JSON under a root field in Object style, the key going into _key", async () => {
    const id = await upload("tags.json", '{"meta":{"v":1},"data":{"red":{"hex":"f00"},"blue":{"hex":"00f","dark":true}}}');
    const { job } = await run(plan("json", [{ upload: id, source: "tags", target: "tags", action: "createTable" }], { json: { style: "object", rootField: "data" } }));
    expect(job.state).toBe("done");
    expect(query("SELECT * FROM tags ORDER BY _key")).toEqual([{ hex: "00f", _key: "blue", dark: "true" }, { hex: "f00", _key: "red", dark: null }]);
  });

  it("reads JSON lines, blank lines skipped", async () => {
    const id = await upload("e.jsonl", '{"a":1}\n\n{"a":2,"b":"x"}\n');
    const { job } = await run(plan("jsonl", [{ upload: id, source: "e", target: "events", action: "createTable" }]));
    expect(items(job)).toEqual([["e", "done", 2, 2]]);
    expect(query("SELECT a, b FROM events ORDER BY a")).toEqual([{ a: "1", b: null }, { a: "2", b: "x" }]);
  });

  it("writes a file column under the name Configure columns gives it, and only the columns used", async () => {
    const id = await upload("m.csv", "full_name,mail,junk\nAnn,a@x.io,zzz\n");
    const { job } = await run(plan("csv", [{
      upload: id, source: "m", target: "users", action: "appendData",
      columns: [{ src: "full_name", dst: "name" }, { src: "mail", dst: "email" }, { src: "junk", dst: "junk", skip: true }],
    }]));
    expect(job.state).toBe("done");
    expect(query("SELECT name, email FROM users WHERE id > 1")).toEqual([{ name: "Ann", email: "a@x.io" }]);
    expect(messages(job).filter((m) => m.startsWith("warning"))).toEqual([]);
  });

  it("leaves out a column the database computes", async () => {
    const id = await upload("c.csv", "a,doubled\n2,999\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "c", target: "calc", action: "appendData" }]));
    expect(job.state).toBe("done");
    expect(query("SELECT a, doubled FROM calc")).toEqual([{ a: 2, doubled: 4 }]);
    expect(messages(job)).toContain("warning: c: doubled is computed by the database: left out");
  });

  it("passes the reader's warnings on once the file is read", async () => {
    const id = await upload("r.csv", "name,email\nAnn,a@x.io\nBroken\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "r", target: "users", action: "appendData" }]));
    expect(messages(job)).toContain("warning: r: Skipped 1 row without the 2 fields of the first row: line 3");
  });
});

describe("actions on a table that exists", () => {
  it("Truncate and import deletes the old rows first", async () => {
    const id = await upload("u.csv", "name\nNew\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "u", target: "users", action: "truncate" }]));
    expect(job.state).toBe("done");
    expect(query("SELECT name FROM users")).toEqual([{ name: "New" }]);
    expect(messages(job)).toContain("info: Deleting the rows of users");
  });

  it("refuses to empty a table another one points at, leaving both as they were", async () => {
    const id = await upload("p.csv", "id\n5\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "p", target: "parent", action: "truncate" }]));
    expect(job.state).toBe("error");
    expect(job.items[0]!.error).toBe("child has a foreign key onto parent, so its rows cannot all be deleted: choose Append data, or remove the key in the Structure tab first");
    expect(query("SELECT id FROM parent")).toEqual([{ id: 1 }]);
    expect(query("SELECT id FROM child")).toEqual([{ id: 1 }]);
  });

  it("Drop and create table builds the table again from the file", async () => {
    const id = await upload("u.csv", "x,y\n1,2\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "u", target: "users", action: "dropCreateTable" }]));
    expect(job.state).toBe("done");
    expect(query("SELECT * FROM users")).toEqual([{ x: "1", y: "2" }]);
    expect(messages(job).slice(1, 3)).toEqual(["info: Dropping table users", "info: Creating table users"]);
  });

  it("Append data into a table that is not there fails the row, and the rows after it stay Queued", async () => {
    const a = await upload("a.csv", "x\n1\n");
    const b = await upload("b.csv", "x\n2\n");
    const { job, audits } = await run(plan("csv", [
      { upload: a, source: "a", target: "missing", action: "appendData" },
      { upload: b, source: "b", target: "other", action: "createTable" },
    ]));
    expect(job.state).toBe("error");
    expect(items(job)).toEqual([["a", "error", 0, 0], ["b", "queued", 0, 0]]);
    expect(job.items[0]!.error).toBe("Table missing not found");
    expect(messages(job)).toEqual(["info: Reading file a", "error: a: Table missing not found"]);
    expect(query("SELECT name FROM sqlite_master WHERE name IN ('missing', 'other')")).toEqual([]);
    expect(audits.map((a) => [a.source, a.error, a.rowCount])).toEqual([["a", "Table missing not found", 0]]);
  });

  it("refuses a view", async () => {
    const id = await upload("v.csv", "name\nx\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "v", target: "user_names", action: "createTable" }]));
    expect(job.items[0]!.error).toBe("user_names is a view: import into a table");
  });
});

describe("one transaction a file", () => {
  it("keeps none of a file's rows when a later one fails, the table it created included", async () => {
    const ok = await upload("ok.csv", "x\n1\n");
    const bad = await upload("bad.csv", "name,score\nA,1\nB,2\nC,-5\n");
    const after = await upload("after.csv", "x\n1\n");
    const { job, audits } = await run(plan("csv", [
      { upload: ok, source: "ok", target: "made", action: "createTable" },
      { upload: bad, source: "bad", target: "users", action: "truncate" },
      { upload: after, source: "after", target: "later", action: "createTable" },
    ]));
    expect(job.state).toBe("error");
    expect(items(job)).toEqual([["ok", "done", 1, 1], ["bad", "error", 3, 0], ["after", "queued", 0, 0]]);
    expect(job.items[1]!.error).toMatch(/CHECK constraint failed/);
    // The truncate and the two good rows went back with the failing one.
    expect(query("SELECT name FROM users")).toEqual([{ name: "Old" }]);
    expect(query("SELECT x FROM made")).toEqual([{ x: "1" }]);
    expect(messages(job)).toContain("info: bad: rolled back, users holds none of the file's rows");
    expect(audits[1]).toMatchObject({ source: "bad", rowCount: 0 });
    expect(audits[1]!.error).toMatch(/CHECK constraint failed/);
    // Its transaction is over, not left holding the file's write lock.
    const next = await upload("next.csv", "name\nNext\n");
    const again = await run(plan("csv", [{ upload: next, source: "next", target: "users", action: "appendData" }]));
    expect(again.job.state).toBe("done");
  });

  it("rolls back a CREATE TABLE when the rows fail", async () => {
    const id = await upload("n.csv", "a\n1\n");
    // NOT NULL holds only in the table that exists: the created one is all nullable TEXT. Fail on a value instead.
    const bad = await upload("bin.csv", "name,avatar\nA,%%%\n");
    await run(plan("csv", [{ upload: id, source: "n", target: "fresh", action: "createTable" }]));
    const { job } = await run(plan("csv", [{ upload: bad, source: "bin", target: "users", action: "appendData" }]));
    expect(job.items[0]!.error).toBe('Row 1, column avatar: the value is not base64, nor a {"$binary": …} object');
    expect(query("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 1 }]);
  });

  it("Stop cancels the statement running, rolls back the file being written and leaves the rest Queued", async () => {
    const big = await upload("big.csv", `name\n${Array.from({ length: 200_000 }, (_, i) => `n${i}`).join("\n")}\n`);
    const after = await upload("after.csv", "x\n1\n");
    // SQLite cannot cancel a statement, so the session's cancel is watched instead.
    let cancels = 0;
    const real = target();
    const watched: GridTarget = {
      ...real,
      adapter: {
        ...real.adapter,
        openWriteSession: async (config) => {
          const session = await real.adapter.openWriteSession(config);
          return { ...session, cancel: () => { cancels++; session.cancel(); } };
        },
      },
    };
    const { job, audits } = await run(plan("csv", [
      { upload: big, source: "big", target: "users", action: "appendData" },
      { upload: after, source: "after", target: "later", action: "createTable" },
    ]), (j) => {
      const poll = (): void => {
        if (j.items[0]!.rowsRead > 0) stopJob(j);
        else setTimeout(poll, 0);
      };
      poll();
    }, watched);
    expect(cancels).toBe(1);
    expect(job.state).toBe("stopped");
    expect(job.items.map((i) => i.state)).toEqual(["stopped", "queued"]);
    expect(job.items[0]!.rowsWritten).toBe(0);
    expect(query("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 1 }]);
    expect(audits[0]!.error).toMatch(/^Stopped after [\d,]+ rows$/);
    expect(messages(job).some((m) => /^info: big: stopped after [\d,]+ rows; none of them were kept$/.test(m))).toBe(true);
  });

  it("says when the uploaded file is gone", async () => {
    const id = await upload("x.csv", "a\n1\n");
    await removeUpload(id);
    const { job } = await run(plan("csv", [{ upload: id, source: "x", target: "t", action: "createTable" }]));
    expect(job.items[0]!.error).toBe(UPLOAD_GONE);
  });

  it("fails a file with no columns", async () => {
    const id = await upload("empty.csv", "\n\n");
    const { job } = await run(plan("csv", [{ upload: id, source: "empty", target: "t", action: "createTable" }]));
    expect(job.items[0]!.error).toBe("The file has no columns to import");
  });

  it("fails a file of the wrong shape before touching the table", async () => {
    const id = await upload("o.json", '{"a":1}');
    const { job } = await run(plan("json", [{ upload: id, source: "o", target: "users", action: "dropCreateTable" }]));
    expect(job.items[0]!.error).toMatch(/is a JSON object, not an array/);
    expect(query("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 1 }]);
  });
});

describe("Preview", () => {
  it("shows the first 100 rows as Import reads them, Configure columns applied", async () => {
    const id = await upload("p.csv", `a,b\n${Array.from({ length: 150 }, (_, i) => `${i},x${i}`).join("\n")}\n`);
    const preview = await previewUpload(id, "csv", { csv: { delimiter: "", header: true }, json: { style: "array", keyField: "", rootField: "" } }, [{ src: "b", dst: "B" }]);
    expect(preview!.columns).toEqual(["B"]);
    expect(preview!.rows).toHaveLength(100);
    expect(preview!.rows[0]).toEqual(["x0"]);
    expect(preview!.warnings).toEqual([]);
  });

  it("stops at 100 rows when the file is read in several batches", async () => {
    const id = await upload("p.jsonl", Array.from({ length: 2_500 }, (_, i) => `{"i":${i}}`).join("\n"));
    const preview = await previewUpload(id, "jsonl", { csv: { delimiter: "", header: true }, json: { style: "array", keyField: "", rootField: "" } });
    expect(preview!.rows).toHaveLength(100);
    expect(preview!.rows[99]).toEqual(["99"]);
  });

  it("shows a JSON number as written, and the reader's warnings so far", async () => {
    const id = await upload("p.json", '[{"n":9007199254740993},1,{"n":true}]');
    const preview = await previewUpload(id, "json", { csv: { delimiter: "", header: true }, json: { style: "array", keyField: "", rootField: "" } });
    expect(preview).toEqual({ columns: ["n"], rows: [["9007199254740993"], [true]], warnings: ["Skipped 1 item that are not JSON objects: item 2"] });
  });

  it("is null for an upload that is gone, and lets the upload go after", async () => {
    expect(await previewUpload("AAAAAAAAAAAAAAAAAAAAAA", "csv", { csv: { delimiter: "", header: true }, json: { style: "array", keyField: "", rootField: "" } })).toBeNull();
    const id = await upload("p.csv", "a\n1\n");
    await previewUpload(id, "csv", { csv: { delimiter: "", header: true }, json: { style: "array", keyField: "", rootField: "" } });
    await removeUpload(id);
    expect(readdirSync(importsDir())).toEqual([]);
  });
});

describe("uploads", () => {
  it("keeps the body on disk under an id of its own, which holds no part of the name", async () => {
    const saved = await saveUpload("../../etc/passwd.csv", bytes("a,b\n", "1,2\n"), new AbortController().signal);
    expect(saved.name).toBe("../../etc/passwd.csv");
    expect(saved.size).toBe(8);
    expect(isUploadId(saved.id)).toBe(true);
    const held = holdUpload(saved.id)!;
    expect(held.path).toBe(join(importsDir(), saved.id));
    expect(await Bun.file(held.path).text()).toBe("a,b\n1,2\n");
    held.release();
  });

  it("keeps a large body byte for byte, in pieces bigger than the writer holds at once", async () => {
    const pieces = [crypto.getRandomValues(new Uint8Array(65_536)), new Uint8Array(6_000_000).fill(7), crypto.getRandomValues(new Uint8Array(65_536)), new Uint8Array(5_000_001).fill(9)];
    const saved = await saveUpload("big.bin", bytes(...pieces), new AbortController().signal);
    const held = holdUpload(saved.id)!;
    const written = new Uint8Array(await Bun.file(held.path).arrayBuffer());
    held.release();
    const sent = Buffer.concat(pieces);
    expect(saved.size).toBe(sent.byteLength);
    expect(written.byteLength).toBe(sent.byteLength);
    expect(Buffer.from(written).equals(sent)).toBe(true);
  });

  it("refuses a name that is empty, too long, or holds a control character", async () => {
    expect(uploadNameProblem(" ")).toBe("The file needs a name");
    expect(uploadNameProblem("a".repeat(256))).toBe("The file name is longer than 255 characters");
    expect(uploadNameProblem("a\u0000.csv")).toBe("The file name holds a control character");
    expect(uploadNameProblem("a".repeat(255))).toBeNull();
    await expect(saveUpload("", bytes("x"), new AbortController().signal)).rejects.toEqual(new UploadError("The file needs a name", 400));
  });

  it("refuses a file of no bytes, keeping nothing of it", async () => {
    await expect(saveUpload("a.csv", null, new AbortController().signal)).rejects.toEqual(new UploadError("The file is empty", 400));
    await expect(saveUpload("a.csv", bytes(), new AbortController().signal)).rejects.toEqual(new UploadError("The file is empty", 400));
    expect(readdirSync(importsDir())).toEqual([]);
  });

  it("refuses a file past 128 MB with 413, and keeps nothing of it", async () => {
    const tooBig = Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1);
    const error = await saveUpload("big.csv", bytes("a\n", tooBig), new AbortController().signal).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).status).toBe(413);
    expect((error as Error).message).toBe("The file is larger than 128 MB");
    expect(readdirSync(importsDir())).toEqual([]);
  });

  it("keeps nothing of an upload the browser gave up on", async () => {
    const stop = new AbortController();
    async function* slow(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("a\n");
      stop.abort();
      yield new TextEncoder().encode("1\n");
    }
    await expect(saveUpload("a.csv", slow(), stop.signal)).rejects.toThrow();
    expect(readdirSync(importsDir())).toEqual([]);
  });

  it("removes the file on Remove, and an upload being read only once its last reader lets it go", async () => {
    const id = await upload("a.csv", "a\n");
    const first = holdUpload(id)!;
    const second = holdUpload(id)!;
    expect(await removeUpload(id)).toBe(true);
    expect(holdUpload(id)).toBeNull();
    // Letting go twice counts once: the other reader still has the file.
    first.release();
    first.release();
    await Bun.sleep(10);
    expect(existsSync(first.path)).toBe(true);
    second.release();
    await Bun.sleep(10);
    expect(existsSync(first.path)).toBe(false);
    expect(await removeUpload(id)).toBe(false);
  });

  it("removes an upload no one reads at once", async () => {
    const id = await upload("a.csv", "a\n");
    const { path } = holdUpload(id)!;
    holdUpload(id)!.release();
    await resetUploads();
    expect(existsSync(path)).toBe(false);
  });

  it("lets go of an upload no one has read for an hour, counted from when its last reader let it go", async () => {
    const t0 = Date.parse("2026-10-03T00:00:00Z");
    const hour = IMPEXP_FILE_TTL_MS;
    const stored = (id: string) => existsSync(join(importsDir(), id));
    try {
      setSystemTime(t0);
      const idle = await upload("idle.csv", "a\n");
      const busy = await upload("busy.csv", "a\n");
      const held = holdUpload(busy)!;
      await sweepUploads(t0 + hour - 1);
      expect([stored(idle), stored(busy)]).toEqual([true, true]);
      setSystemTime(t0 + 2 * hour);
      await sweepUploads(t0 + 2 * hour);
      // Being read for two hours does not make an upload idle.
      expect([stored(idle), stored(busy)]).toEqual([false, true]);
      held.release();
      await sweepUploads(t0 + 3 * hour - 1);
      expect(stored(busy)).toBe(true);
      await sweepUploads(t0 + 3 * hour);
      expect(stored(busy)).toBe(false);
      expect(holdUpload(busy)).toBeNull();
    } finally {
      setSystemTime();
    }
  });
});
