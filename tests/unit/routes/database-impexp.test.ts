/**
 * Export advanced's routes on SQLite: a job started, read while it runs and once it has ended, its
 * files downloaded by ticket; a Query source held to `/query`'s rules; what is audited; and the
 * grid's own SELECT for the tab to start from.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { configService } from "../../../src/services/config.service.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { abandonAllExportTickets } from "../../../src/services/database/grid-export-tickets.ts";
import { MAX_RUNNING_JOBS, createJob, resetJobs } from "../../../src/services/database/impexp/impexp-job-store.ts";
import { importsDir } from "../../../src/services/database/impexp/impexp-files.ts";
import { UPLOAD_GONE } from "../../../src/services/database/impexp/import-job-runner.ts";
import { resetUploads } from "../../../src/services/database/impexp/import-uploads.ts";
import { READONLY_IMPORT } from "../../../src/services/database/db-errors.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { EXPORT_QUERY_NOT_A_READ, READONLY_EXPORT_QUERY } from "../../../src/server/routes/database-impexp.ts";
import { closeAuditDb, getAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";
import {
  DEFAULT_EXPORT_OPTIONS, DEFAULT_IMPORT_OPTIONS, IMPORT_MAX_FILE_BYTES, type ImpExpJobStatus, type ImportPreview, type ImportUpload,
} from "../../../src/shared/db-impexp.ts";
import type { GridExportTicket } from "../../../src/shared/db-grid-export.ts";
import { readZip } from "../../helpers/read-zip.ts";

const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;
let targetDbPath: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedTargetDb(): string {
  const path = join(tempDir("ppm-impexp-target-"), "target.db");
  const db = new Database(path);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)");
  db.exec("INSERT INTO items VALUES (1, 'Apple', 5), (2, 'Pear', NULL), (3, 'Fig', 12)");
  db.exec("CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)");
  db.exec("INSERT INTO tags VALUES (1, 'red')");
  db.close();
  return path;
}

let auth = false;
const app = () => {
  const a = new Hono();
  if (auth) a.use("/api/*", authMiddleware);
  return a.route("/api/db", databaseRoutes);
};

async function createConnection(readonly: boolean): Promise<number> {
  const res = await app().request("/api/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sqlite", name: readonly ? "impexp-ro" : "impexp-rw", connectionConfig: { type: "sqlite", path: targetDbPath } }),
  });
  const id = ((await res.json()) as { data: { id: number } }).data.id;
  if (!readonly) {
    await app().request(`/api/db/connections/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readonly: 0 }),
    });
  }
  return id;
}

/** A connection that may write, made through the routes with the token. */
async function createConnectionAs(headers: Record<string, string>): Promise<number> {
  const res = await app().request("/api/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ type: "sqlite", name: "impexp-rw-token", connectionConfig: { type: "sqlite", path: targetDbPath } }),
  });
  const id = ((await res.json()) as { data: { id: number } }).data.id;
  await app().request(`/api/db/connections/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ readonly: 0 }),
  });
  return id;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(path, { method: "POST", headers: { "Content-Type": "application/json", "x-ppm-client": "web", ...headers }, body: JSON.stringify(body) });

async function startExport(id: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await post(`/api/db/connections/${id}/impexp/export`, { format: "csv", options: DEFAULT_EXPORT_OPTIONS, ...body }, headers);
  const json = (await res.json()) as { data: { jobId: string }; error?: string };
  return { status: res.status, jobId: json.data?.jobId, error: json.error };
}

async function jobStatus(jobId: string, since = 0): Promise<{ status: number; data: ImpExpJobStatus; error?: string }> {
  const res = await app().request(`/api/db/impexp/jobs/${jobId}?since=${since}`);
  const json = (await res.json()) as { data: ImpExpJobStatus; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

async function waitForJob(jobId: string): Promise<ImpExpJobStatus> {
  for (let i = 0; i < 500; i++) {
    const { data } = await jobStatus(jobId);
    if (data.state !== "running") return data;
    await Bun.sleep(10);
  }
  throw new Error("The job did not end");
}

async function downloadFile(jobId: string, name: string): Promise<Response> {
  const res = await post(`/api/db/impexp/jobs/${jobId}/download`, { name });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: GridExportTicket };
  expect(data.fileName).toBe(name);
  return app().request(`/api/db/grid-export/${data.ticket}`);
}

const exportLogs = () => listQueryLogs({ limit: 200 }).filter((l) => l.source === "export");
const importLogs = () => listQueryLogs({ limit: 200 }).filter((l) => l.source === "import");

const put = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  app().request(path, { method: "PUT", headers: { "x-ppm-client": "web", ...headers }, body });

async function uploadFile(name: string, text: string): Promise<ImportUpload> {
  const res = await put(`/api/db/impexp/uploads?name=${encodeURIComponent(name)}`, text);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ImportUpload }).data;
}

async function startImport(id: number, files: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const res = await post(`/api/db/connections/${id}/impexp/import`, { format: "csv", options: DEFAULT_IMPORT_OPTIONS, files, ...extra });
  const json = (await res.json()) as { data: { jobId: string }; error?: string };
  return { status: res.status, jobId: json.data?.jobId, error: json.error };
}

async function preview(uploadId: string, body: Record<string, unknown>): Promise<{ status: number; data: ImportPreview; error?: string }> {
  const res = await post(`/api/db/impexp/uploads/${uploadId}/preview`, { format: "csv", options: DEFAULT_IMPORT_OPTIONS, ...body });
  const json = (await res.json()) as { data: ImportPreview; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

function readTarget(sql: string): unknown[] {
  const db = new Database(targetDbPath, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}
const tables = (...names: string[]) => ({ type: "database", tables: names.map((name) => ({ name, target: `${name}.csv` })) });

beforeEach(() => {
  process.env.PPM_HOME = tempDir("ppm-impexp-home-");
  closeAuditDb();
  _resetPpmDir();
  initAdapters();
  setDb(openTestDb());
  targetDbPath = seedTargetDb();
  getAuditDb();
  auth = false;
});

afterEach(async () => {
  resetJobs();
  abandonAllExportTickets();
  await resetUploads();
});

afterAll(() => {
  closeAuditDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("POST connections/:id/impexp/export", () => {
  it("starts a job that writes each table, whose files then download by ticket", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items", "tags") });
    expect(started.status).toBe(200);
    const done = await waitForJob(started.jobId);
    expect(done.state).toBe("done");
    expect(done.kind).toBe("export");
    expect(done.items.map((i) => [i.source, i.target, i.state, i.rowsWritten])).toEqual([
      ["items", "items.csv", "done", 3], ["tags", "tags.csv", "done", 1],
    ]);
    expect(done.files.map((f) => f.name)).toEqual(["items.csv", "tags.csv"]);
    expect(done.endedAt).not.toBeNull();

    const res = await downloadFile(started.jobId, "items.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''items.csv");
    expect(await res.text()).toBe("id,name,qty\n1,Apple,5\n2,Pear,\n3,Fig,12\n");
  });

  it("audits each table as an export of its own, naming the job", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items", "tags") });
    await waitForJob(started.jobId);
    const logs = exportLogs();
    expect(logs).toHaveLength(2);
    const items = logs.find((l) => l.sql.includes('FROM "items"'))!;
    expect(items).toMatchObject({ status: "ok", actor: "human", operation: "select", row_count: 3 });
    expect(JSON.parse(items.params_json!)).toMatchObject({ job: started.jobId, format: "csv", target: "items.csv", table: "items" });
  });

  it("names a zip's content type, and every file inside it", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items", "tags"), zip: { name: "all" } });
    const done = await waitForJob(started.jobId);
    expect(done.files.map((f) => f.name)).toEqual(["all.zip"]);
    const res = await downloadFile(started.jobId, "all.zip");
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect([...readZip(new Uint8Array(await res.arrayBuffer())).keys()]).toEqual(["items.csv", "tags.csv"]);
  });

  it("refuses a target that is a path before any job starts", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: { type: "database", tables: [{ name: "items", target: "../../x.csv" }] } });
    expect(started.status).toBe(400);
    expect(started.error).toBe('"../../x.csv" is a path; give a file name');
  });

  it("refuses a body that is not JSON, and a connection that is not there", async () => {
    const id = await createConnection(true);
    const res = await app().request(`/api/db/connections/${id}/impexp/export`, { method: "POST", body: "{" });
    expect(res.status).toBe(400);
    expect((await startExport(999_999, { source: tables("items") })).status).toBe(404);
  });

  it("reports a table that is not there on its row, not as a refused request", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items", "nope", "tags") });
    expect(started.status).toBe(200);
    const done = await waitForJob(started.jobId);
    expect(done.state).toBe("error");
    expect(done.items.map((i) => i.state)).toEqual(["done", "error", "queued"]);
    expect(done.items[1]!.error).toBe('Table "nope" not found');
  });

  it("answers 429 while as many jobs as may run are running", async () => {
    const id = await createConnection(true);
    for (let i = 0; i < MAX_RUNNING_JOBS; i++) await createJob("export", [{ source: "x", target: "x.csv" }]);
    const started = await startExport(id, { source: tables("items") });
    expect(started.status).toBe(429);
    expect(started.error).toContain("jobs are already running");
  });
});

describe("a Query source is typed SQL", () => {
  const query = (sql: string, target = "q.csv") => ({ source: { type: "query", sql, target } });

  it("runs one SELECT, its terminator left off, and writes what it returns", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, query("SELECT name FROM items WHERE qty > 6 ORDER BY id;  "));
    const done = await waitForJob(started.jobId);
    expect(done.state).toBe("done");
    expect(await (await downloadFile(started.jobId, "q.csv")).text()).toBe("name\nFig\n");
    expect(exportLogs()[0]!.sql).toBe("SELECT name FROM items WHERE qty > 6 ORDER BY id");
  });

  it("on a readonly connection refuses a write with 403, audited as blocked", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, query("DELETE FROM items"));
    expect(started.status).toBe(403);
    expect(started.error).toBe(READONLY_EXPORT_QUERY);
    const [log] = exportLogs();
    expect(log).toMatchObject({ status: "blocked", sql: "DELETE FROM items", error: READONLY_EXPORT_QUERY });
  });

  it("on a connection that may write still runs only a read", async () => {
    const id = await createConnection(false);
    for (const sql of ["DELETE FROM items", "VACUUM INTO '/tmp/copy.db'", "SELECT * INTO x FROM items"]) {
      const started = await startExport(id, query(sql));
      expect(started.status).toBe(400);
      expect(started.error).toBe(EXPORT_QUERY_NOT_A_READ);
    }
    expect(exportLogs()).toEqual([]);
  });

  it("refuses more than one statement", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, query("SELECT 1; SELECT 2"));
    expect(started.status).toBe(400);
    expect(started.error).toBe("Export runs one query: remove the statements after the first");
  });
});

describe("a job, by its id", () => {
  it("returns only the messages the tab has not seen", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items") });
    const done = await waitForJob(started.jobId);
    expect(done.messageCount).toBe(3);
    const later = await jobStatus(started.jobId, 2);
    expect(later.data.messages.map((m) => m.text)).toEqual(["Finished job"]);
    expect(later.data.messageCount).toBe(3);
  });

  it("answers 404 for a job that is not there, on every route", async () => {
    const gone = "A".repeat(22);
    expect((await jobStatus(gone)).status).toBe(404);
    expect((await post(`/api/db/impexp/jobs/${gone}/stop`, {})).status).toBe(404);
    expect((await post(`/api/db/impexp/jobs/${gone}/download`, { name: "x.csv" })).status).toBe(404);
  });

  it("leaves a job that has ended as it is when asked to stop", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items") });
    await waitForJob(started.jobId);
    const res = await post(`/api/db/impexp/jobs/${started.jobId}/stop`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: ImpExpJobStatus }).data.state).toBe("done");
  });

  it("answers 404 for a file the job did not write", async () => {
    const id = await createConnection(true);
    const started = await startExport(id, { source: tables("items") });
    await waitForJob(started.jobId);
    expect((await post(`/api/db/impexp/jobs/${started.jobId}/download`, { name: "../items.csv" })).status).toBe(404);
    expect((await post(`/api/db/impexp/jobs/${started.jobId}/download`, { name: 3 })).status).toBe(404);
  });
});

describe("PUT impexp/uploads", () => {
  it("keeps the body as a file and answers its id, name and size", async () => {
    const res = await put("/api/db/impexp/uploads?name=people.csv", "id,name\n1,Ann\n");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: ImportUpload };
    expect(data).toMatchObject({ name: "people.csv", size: 14 });
    expect(readdirSync(importsDir())).toEqual([data.id]);
  });

  it("answers 400 for a file with no name or no bytes", async () => {
    const unnamed = await put("/api/db/impexp/uploads", "a\n");
    expect([unnamed.status, ((await unnamed.json()) as { error: string }).error]).toEqual([400, "The file needs a name"]);
    const empty = await put("/api/db/impexp/uploads?name=a.csv", "");
    expect([empty.status, ((await empty.json()) as { error: string }).error]).toEqual([400, "The file is empty"]);
  });

  it("keeps nothing of an upload the browser gave up on", async () => {
    const giveUp = new AbortController();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode("a\n1\n")); return; }
        giveUp.abort();
        controller.error(new Error("The connection closed"));
      },
    });
    const res = await app().request("/api/db/impexp/uploads?name=a.csv", { method: "PUT", body, signal: giveUp.signal });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, "The upload was cancelled"]);
    expect(readdirSync(importsDir())).toEqual([]);
  });

  it("answers 413 for a file past 128 MB, keeping nothing of it", async () => {
    const big = Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(big); controller.close(); } });
    const res = await put("/api/db/impexp/uploads?name=big.csv", body);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("The file is larger than 128 MB");
    expect(readdirSync(importsDir())).toEqual([]);
  });
});

describe("POST impexp/uploads/:id/preview and DELETE impexp/uploads/:id", () => {
  it("answers the first rows as the job would write them", async () => {
    const upload = await uploadFile("people.csv", "id;name\n1;Ann\n2;\n");
    const res = await preview(upload.id, { columns: [{ src: "name", dst: "full_name" }] });
    expect(res).toEqual({ status: 200, data: { columns: ["full_name"], rows: [["Ann"], [null]], warnings: [] }, error: undefined });
  });

  it("answers 400 with the reader's words for a file it cannot read as asked", async () => {
    const upload = await uploadFile("rows.json", '{"a":1}');
    const wrongShape = await preview(upload.id, { format: "json" });
    expect([wrongShape.status, wrongShape.error]).toEqual([400, "The file is a JSON object, not an array: choose Object style, or name the Root field the rows are under"]);
    const missingColumn = await preview(upload.id, { format: "json", options: { ...DEFAULT_IMPORT_OPTIONS, json: { style: "object", keyField: "", rootField: "" } }, columns: [{ src: "nope", dst: "x" }] });
    expect([missingColumn.status, missingColumn.error]).toEqual([400, 'Column "nope" is not in "rows.json"']);
    const badRequest = await preview(upload.id, { format: "xml" });
    expect([badRequest.status, badRequest.error]).toEqual([400, "format is not one Import reads"]);
  });

  it("answers 404 for an upload that is gone, and DELETE removes one", async () => {
    expect(await preview("AAAAAAAAAAAAAAAAAAAAAA", {})).toMatchObject({ status: 404, error: UPLOAD_GONE });
    expect(await preview("not-an-upload-id", {})).toMatchObject({ status: 404, error: UPLOAD_GONE });
    const upload = await uploadFile("a.csv", "a\n1\n");
    const removed = await app().request(`/api/db/impexp/uploads/${upload.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(readdirSync(importsDir())).toEqual([]);
    expect(await preview(upload.id, {})).toMatchObject({ status: 404, error: UPLOAD_GONE });
    expect((await app().request(`/api/db/impexp/uploads/${upload.id}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("POST connections/:id/impexp/import", () => {
  it("writes each uploaded file into its table, and audits each as an import of its own", async () => {
    const id = await createConnection(false);
    const people = await uploadFile("people.csv", "id,name\n1,Ann\n2,\n");
    const items = await uploadFile("more-items.csv", "id,name,qty\n4,Kiwi,7\n");
    const started = await startImport(id, [
      { upload: people.id, source: "people", target: "people", action: "createTable" },
      { upload: items.id, source: "more-items", target: "items", action: "appendData" },
    ]);
    expect(started.status).toBe(200);
    const done = await waitForJob(started.jobId);
    expect(done.kind).toBe("import");
    expect(done.state).toBe("done");
    expect(done.items.map((i) => [i.source, i.target, i.state, i.rowsWritten])).toEqual([["people", "people", "done", 2], ["more-items", "items", "done", 1]]);
    expect(readTarget("SELECT id, name FROM people ORDER BY id")).toEqual([{ id: "1", name: "Ann" }, { id: "2", name: null }]);
    expect(readTarget("SELECT name, qty FROM items WHERE id = 4")).toEqual([{ name: "Kiwi", qty: 7 }]);

    const logs = importLogs();
    expect(logs).toHaveLength(2);
    const log = logs.find((l) => l.sql.includes('INSERT INTO "items"'))!;
    expect(log).toMatchObject({ status: "ok", actor: "human", operation: "insert", row_count: 1, error: null });
    expect(JSON.parse(log.params_json!)).toEqual({ job: started.jobId, format: "csv", file: "more-items.csv", table: "items", schema: null, action: "appendData" });
  });

  it("reads on to its end a file removed while it is read, and still names it in the audit", async () => {
    const id = await createConnection(false);
    const upload = await uploadFile("people.csv", "id\n1\n2\n");
    const started = await startImport(id, [{ upload: upload.id, source: "people", target: "people", action: "createTable" }]);
    expect((await app().request(`/api/db/impexp/uploads/${upload.id}`, { method: "DELETE" })).status).toBe(200);
    const done = await waitForJob(started.jobId);
    expect(done.items.map((i) => [i.state, i.rowsWritten])).toEqual([["done", 2]]);
    expect(JSON.parse(importLogs()[0]!.params_json!)).toMatchObject({ file: "people.csv" });
    expect(readdirSync(importsDir())).toEqual([]);
  });

  it("audits a file that failed with its error and no rows", async () => {
    const id = await createConnection(false);
    const upload = await uploadFile("a.csv", "x\n1\n");
    const started = await startImport(id, [{ upload: upload.id, source: "a", target: "missing", action: "appendData" }]);
    const done = await waitForJob(started.jobId);
    expect(done.state).toBe("error");
    expect(importLogs()).toEqual([expect.objectContaining({ status: "error", error: "Table missing not found", row_count: 0 })]);
  });

  it("on a readonly connection refuses with 403 before reading anything, audited as blocked", async () => {
    const id = await createConnection(true);
    const upload = await uploadFile("people.csv", "id\n1\n");
    const started = await startImport(id, [{ upload: upload.id, source: "people", target: "people", action: "createTable" }]);
    expect([started.status, started.error]).toEqual([403, READONLY_IMPORT]);
    expect(readTarget("SELECT name FROM sqlite_master WHERE name = 'people'")).toEqual([]);
    const [log] = importLogs();
    expect(log).toMatchObject({ status: "blocked", sql: 'INSERT INTO "people"', error: READONLY_IMPORT, operation: "insert" });
    expect(JSON.parse(log!.params_json!)).toMatchObject({ file: "people.csv", table: "people", action: "createTable" });
  });

  it("answers 400 for a request it cannot run", async () => {
    const id = await createConnection(false);
    const upload = await uploadFile("a.csv", "x\n1\n");
    const file = { upload: upload.id, source: "a", target: "a", action: "createTable" };
    expect(await startImport(id, [], {})).toMatchObject({ status: 400, error: "Add at least one file" });
    expect(await startImport(id, [file], { format: "xlsx" })).toMatchObject({ status: 400, error: "format is not one Import reads" });
    expect(await startImport(id, [{ ...file, upload: "../x" }])).toMatchObject({ status: 400, error: "File 1: upload is not the id of an uploaded file" });
    expect(await startImport(id, [{ ...file, action: "merge" }])).toMatchObject({ status: 400, error: '"a": action is not one of its choices' });
    expect(await startImport(id, [{ ...file, target: " " }])).toMatchObject({ status: 400, error: '"a": The target table needs a name' });
    const notJson = await app().request(`/api/db/connections/${id}/impexp/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
    expect(importLogs()).toEqual([]);
  });

  it("answers 404 for a connection that is not there, and 429 while as many jobs as may run are running", async () => {
    const upload = await uploadFile("a.csv", "x\n1\n");
    const file = { upload: upload.id, source: "a", target: "a", action: "createTable" };
    expect(await startImport(9999, [file])).toMatchObject({ status: 404, error: "Connection not found" });
    const id = await createConnection(false);
    for (let i = 0; i < MAX_RUNNING_JOBS; i++) await createJob("import", [{ source: "x", target: "x" }]);
    const started = await startImport(id, [file]);
    expect(started.status).toBe(429);
    expect(started.error).toContain("jobs are already running");
  });
});

describe("the token", () => {
  beforeEach(() => {
    configService.set("auth", { enabled: true, token: "impexp-token" });
  });
  afterEach(() => {
    configService.set("auth", { enabled: false, token: "" });
    auth = false;
  });

  it("is asked of every job route, and a job's file then downloads with its ticket alone", async () => {
    const id = await createConnection(true);
    auth = true;
    const bearer = { Authorization: "Bearer impexp-token" };
    expect((await startExport(id, { source: tables("items") })).status).toBe(401);
    const started = await startExport(id, { source: tables("items") }, bearer);
    expect(started.status).toBe(200);
    expect((await app().request(`/api/db/impexp/jobs/${started.jobId}`)).status).toBe(401);
    expect((await post(`/api/db/impexp/jobs/${started.jobId}/download`, { name: "items.csv" })).status).toBe(401);
    for (let i = 0; i < 500; i++) {
      const res = await app().request(`/api/db/impexp/jobs/${started.jobId}`, { headers: bearer });
      if (((await res.json()) as { data: ImpExpJobStatus }).data.state !== "running") break;
      await Bun.sleep(10);
    }
    expect((await put("/api/db/impexp/uploads?name=a.csv", "a\n1\n")).status).toBe(401);
    // Refused before a byte of it was kept.
    expect(existsSync(importsDir())).toBe(false);
    const upload = await put("/api/db/impexp/uploads?name=a.csv", "a\n1\n", bearer);
    expect(upload.status).toBe(200);
    const uploadId = ((await upload.json()) as { data: ImportUpload }).data.id;
    expect((await post(`/api/db/impexp/uploads/${uploadId}/preview`, { format: "csv" })).status).toBe(401);
    expect((await app().request(`/api/db/impexp/uploads/${uploadId}`, { method: "DELETE" })).status).toBe(401);
    const rw = await createConnectionAs(bearer);
    const files = [{ upload: uploadId, source: "a", target: "a", action: "createTable" }];
    expect((await post(`/api/db/connections/${rw}/impexp/import`, { format: "csv", files })).status).toBe(401);
    expect((await post(`/api/db/connections/${rw}/impexp/import`, { format: "csv", files }, bearer)).status).toBe(200);
    const ticketRes = await post(`/api/db/impexp/jobs/${started.jobId}/download`, { name: "items.csv" }, bearer);
    const { data } = (await ticketRes.json()) as { data: GridExportTicket };
    const file = await app().request(`/api/db/grid-export/${data.ticket}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("id,name,qty\n1,Apple,5\n2,Pear,\n3,Fig,12\n");
  });
});
