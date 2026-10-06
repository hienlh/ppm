/**
 * Save cell to file for a value the grid has only the start of, end to end on SQLite: POST grid/cell
 * finds the row again by its key and reads the value whole, and GET grid-export/:ticket is the file.
 * The Postgres and MySQL export tests repeat the read against real servers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { abandonAllExportTickets } from "../../src/services/database/grid-export-tickets.ts";
import { BINARY_PREVIEW_BYTES } from "../../src/services/database/db-values.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { MAX_OPEN_EXPORTS } from "../../src/server/routes/database-grid-export.ts";
import { closeAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import type { GridExportTicket } from "../../src/shared/db-grid-export.ts";

const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;
let targetDbPath: string;
/** 2.5 MB of bytes that are not all alike: three of the download's 1 MB slices, a misplaced one seen. */
const PHOTO = Uint8Array.from({ length: 2_500_000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);

function seedTargetDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-cell-target-"));
  tempDirs.push(dir);
  const path = join(dir, "target.db");
  const db = new Database(path);
  db.exec("CREATE TABLE files (id INTEGER PRIMARY KEY, kind TEXT, data BLOB, note TEXT)");
  const insert = db.prepare("INSERT INTO files (id, kind, data, note) VALUES (?, ?, ?, ?)");
  insert.run(1, "photo", PHOTO, "đơn hàng ✓");
  insert.run(2, "photo", null, null);
  insert.run(3, "other", new Uint8Array([1, 2, 3]), "x");
  db.exec("CREATE TABLE keyless (label TEXT, data BLOB)");
  db.prepare("INSERT INTO keyless VALUES (?, ?)").run("a", new Uint8Array([9]));
  db.close();
  return path;
}

const app = () => new Hono().route("/api/db", databaseRoutes);

/** Read-only, as every connection starts: reading a cell writes nothing. */
async function createConnection(): Promise<number> {
  const res = await app().request("/api/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sqlite", name: "cells", connectionConfig: { type: "sqlite", path: targetDbPath } }),
  });
  return ((await res.json()) as { data: { id: number } }).data.id;
}

async function startCell(id: number, body: Record<string, unknown>) {
  const res = await app().request(`/api/db/connections/${id}/grid/cell`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify({ table: "files", column: "data", key: { id: 1 }, fileName: "files-data.bin", ...body }),
  });
  const json = (await res.json()) as { data: GridExportTicket; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

const download = (ticket: string) => app().request(`/api/db/grid-export/${ticket}`);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-cell-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
  initAdapters();
  setDb(openTestDb());
  targetDbPath = seedTargetDb();
});

afterEach(() => {
  abandonAllExportTickets();
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

describe("POST grid/cell + GET grid-export/:ticket", () => {
  it("downloads bytes past the grid's preview whole, as an attachment typed as bytes", async () => {
    expect(PHOTO.length).toBeGreaterThan(BINARY_PREVIEW_BYTES);
    const id = await createConnection();
    const started = await startCell(id, { fileName: "files-data.png" });
    expect(started.status).toBe(200);
    expect(started.data.fileName).toBe("files-data.png");
    const res = await download(started.data.ticket);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''files-data.png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PHOTO);
    // Once.
    expect((await download(started.data.ticket)).status).toBe(404);
  });

  it("downloads text as UTF-8", async () => {
    const id = await createConnection();
    const started = await startCell(id, { column: "note", fileName: "files-note.txt" });
    expect(new TextDecoder().decode(await (await download(started.data.ticket)).arrayBuffer())).toBe("đơn hàng ✓");
  });

  it("names the file only with what every file system takes", async () => {
    const id = await createConnection();
    const started = await startCell(id, { fileName: "../evil\nname.bin" });
    expect(started.data.fileName).toBe("_evil_name.bin");
    expect((await startCell(id, { fileName: "..." })).data.fileName).toBe("cell.bin");
    expect((await startCell(id, { fileName: "x".repeat(255) })).status).toBe(200);
  });

  it("says why it cannot: the row gone, the cell empty, a key naming two rows, a column or table that is not there", async () => {
    const id = await createConnection();
    expect(await startCell(id, { key: { id: 99 } })).toMatchObject({ status: 404, error: "The row is no longer there: refresh the table to see it" });
    expect(await startCell(id, { key: { id: 2 } })).toMatchObject({
      status: 409, error: "The cell no longer holds bytes or text: refresh the table to see what it holds",
    });
    expect(await startCell(id, { key: { kind: "photo" } })).toMatchObject({
      status: 409, error: "More than one row has this key, so its cell cannot be told apart",
    });
    expect(await startCell(id, { column: "nope" })).toMatchObject({ status: 400, error: 'Table "files" has no column "nope"' });
    expect(await startCell(id, { table: "gone" })).toMatchObject({ status: 404, error: 'Table "gone" not found' });
  });

  it("finds a row of a table with no primary key by its rowid", async () => {
    const id = await createConnection();
    const started = await startCell(id, { table: "keyless", key: { rowid: 1 } });
    expect(started.status).toBe(200);
    expect(new Uint8Array(await (await download(started.data.ticket)).arrayBuffer())).toEqual(new Uint8Array([9]));
  });

  it("refuses a key holding bytes only partly read, and a body that names no row", async () => {
    const id = await createConnection();
    const partial = { $binary: "AAEC", size: 70_000, truncated: true };
    expect(await startCell(id, { key: { data: partial } })).toMatchObject({
      status: 400, error: '"data" holds a value that was only partly loaded, so it cannot be used to find or write the row',
    });
    expect(await startCell(id, { key: {} })).toMatchObject({ status: 400, error: "key must name the row" });
    expect(await startCell(id, { column: "" })).toMatchObject({ status: 400, error: "column is required" });
    expect(await startCell(id, { fileName: "x".repeat(256) })).toMatchObject({
      status: 400, error: "fileName must be text of at most 255 characters",
    });
  });

  it("takes an export's slot while it waits, and gives it back once downloaded", async () => {
    const id = await createConnection();
    // A cell it could not read holds none.
    for (let i = 0; i <= MAX_OPEN_EXPORTS; i++) expect((await startCell(id, { key: { id: 99 } })).status).toBe(404);
    const waiting = [];
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) waiting.push(await startCell(id, {}));
    expect(waiting.every((w) => w.status === 200)).toBe(true);
    expect(await startCell(id, {})).toMatchObject({ status: 429 });
    await (await download(waiting[0]!.data.ticket)).arrayBuffer();
    expect((await startCell(id, {})).status).toBe(200);
  });
});
