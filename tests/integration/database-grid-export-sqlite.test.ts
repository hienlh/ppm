/**
 * DBGate's Export ▸ end to end on SQLite: the ticket from POST grid/export, the file from GET
 * grid-export/:ticket, and what is audited. Runs everywhere; the Postgres and MySQL files repeat the
 * read-side checks against real servers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { configService } from "../../src/services/config.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { abandonAllExportTickets } from "../../src/services/database/grid-export-tickets.ts";
import { parseGridExportRequest } from "../../src/services/database/grid-query-builder.ts";
import { openGridExport } from "../../src/services/database/grid.service.ts";
import { authMiddleware } from "../../src/server/middleware/auth.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { MAX_OPEN_EXPORTS } from "../../src/server/routes/database-grid-export.ts";
import { closeAuditDb, getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { GridExportTicket } from "../../src/shared/db-grid-export.ts";
import { readZip } from "../helpers/read-zip.ts";

const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;
let targetDbPath: string;

function isolatePpmHome(): void {
  const home = mkdtempSync(join(tmpdir(), "ppm-export-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
}

function seedTargetDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-export-target-"));
  tempDirs.push(dir);
  const path = join(dir, "target.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, big INTEGER, data BLOB)`);
  const insert = db.prepare("INSERT INTO items (id, name, qty, big, data) VALUES (?, ?, ?, ?, ?)");
  insert.run(1, "Apple", 5, 1, null);
  insert.run(2, 'say "hi", twice', 12, 2, null);
  insert.run(3, "line\nbreak", null, 9007199254740993n, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  insert.run(4, "pie", 7, 4, null);
  db.exec("CREATE TABLE wide (id INTEGER PRIMARY KEY, body TEXT)");
  const wide = db.prepare("INSERT INTO wide VALUES (?, ?)");
  for (let i = 1; i <= 5; i++) wide.run(i, "x".repeat(1000));
  db.exec("CREATE TABLE many (id INTEGER PRIMARY KEY, label TEXT)");
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) INSERT INTO many SELECT i, 'row ' || i FROM n");
  db.close();
  return path;
}

let auth = false;
const app = () => {
  const a = new Hono();
  if (auth) a.use("/api/*", authMiddleware);
  return a.route("/api/db", databaseRoutes);
};

async function createConnection(readonly = false): Promise<number> {
  const res = await app().request("/api/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sqlite", name: readonly ? "export-ro" : "export-rw", connectionConfig: { type: "sqlite", path: targetDbPath } }),
  });
  const id = ((await res.json()) as { data: { id: number } }).data.id;
  if (!readonly) {
    await app().request(`/api/db/connections/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readonly: 0 }),
    });
  }
  return id;
}

async function startExport(id: number, body: unknown, headers: Record<string, string> = {}) {
  const res = await app().request(`/api/db/connections/${id}/grid/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: GridExportTicket; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

const download = (ticket: string, init: RequestInit = {}) => app().request(`/api/db/grid-export/${ticket}`, init);

async function exportText(id: number, body: Record<string, unknown>): Promise<string> {
  const started = await startExport(id, body);
  expect(started.status).toBe(200);
  const res = await download(started.data.ticket);
  expect(res.status).toBe(200);
  return res.text();
}

const exportLogs = () => listQueryLogs({ limit: 200 }).filter((l) => l.source === "export");

beforeEach(() => {
  isolatePpmHome();
  initAdapters();
  setDb(openTestDb());
  targetDbPath = seedTargetDb();
  getAuditDb();
  auth = false;
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

describe("POST grid/export + GET grid-export/:ticket on SQLite", () => {
  it("writes every row the filters leave, in the sort, with the columns given in their order", async () => {
    const id = await createConnection();
    const csv = await exportText(id, {
      table: "items", format: "csv", columns: ["name", "id"],
      filters: [{ column: "qty", anyOf: [[{ op: "notNull" }]] }], sort: [{ column: "id", dir: "DESC" }],
    });
    // Quoted only where a value needs it, header included, as DBGate's CSV is.
    expect(csv).toBe('name,id\npie,4\n"say ""hi"", twice",2\nApple,1\n');
  });

  it("names the file after the table and sends it as an attachment nobody caches", async () => {
    const id = await createConnection();
    const started = await startExport(id, { table: "items", format: "xlsx", columns: ["id"] });
    expect(started.data.fileName).toBe("items.xlsx");
    expect(started.data.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const res = await download(started.data.ticket);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''items.xlsx");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await res.arrayBuffer();
  });

  it("keeps a 64-bit integer exact and bytes whole in JSON", async () => {
    const id = await createConnection();
    const json = await exportText(id, {
      table: "items", format: "json", columns: ["id", "big", "data"], filters: [{ column: "id", anyOf: [[{ op: "eq", value: 3 }]] }],
    });
    expect(json).toBe('[\n{"id":3,"big":"9007199254740993","data":{"$binary":"3q2+7w==","size":4}}\n]\n');
  });

  it("writes a workbook whose one sheet is named after the table", async () => {
    const id = await createConnection();
    const started = await startExport(id, { table: "items", format: "xlsx", columns: ["id", "name"], sort: [{ column: "id", dir: "ASC" }] });
    const zip = readZip(new Uint8Array(await (await download(started.data.ticket)).arrayBuffer()));
    expect([...zip.keys()].sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml",
    ]);
    expect(zip.get("xl/workbook.xml")!.toString()).toContain('<sheet name="items" sheetId="1" r:id="rId1"/>');
    const sheet = zip.get("xl/worksheets/sheet1.xml")!.toString();
    expect(sheet).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>');
    expect(sheet).toContain('<row r="4"><c r="A4"><v>3</v></c><c r="B4" t="inlineStr"><is><t>line\nbreak</t></is></c></row>');
  });

  it("serves a ticket once", async () => {
    const id = await createConnection();
    const started = await startExport(id, { table: "items", format: "csv", columns: ["id"] });
    expect((await download(started.data.ticket)).status).toBe(200);
    const again = await download(started.data.ticket);
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: string }).error).toBe("This export has been downloaded already, or waited too long. Export again.");
  });

  it("refuses HEAD without spending the ticket", async () => {
    const id = await createConnection();
    const started = await startExport(id, { table: "items", format: "csv", columns: ["id"] });
    const head = await download(started.data.ticket, { method: "HEAD" });
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
    expect(await (await download(started.data.ticket)).text()).toBe("id\n1\n2\n3\n4\n");
  });

  it("answers what the request gets wrong before anything is read", async () => {
    const id = await createConnection();
    expect((await startExport(id, { table: "items", format: "pdf", columns: ["id"] })).status).toBe(400);
    expect((await startExport(id, { table: "items", format: "csv", columns: [] })).error).toBe("columns must list at least one column");
    expect((await startExport(id, { table: "items", format: "csv", columns: ["id", "id"] })).error).toBe("A column is listed twice");
    const unknown = await startExport(id, { table: "items", format: "csv", columns: ["nope"] });
    expect(unknown.status).toBe(400);
    expect((await startExport(id, { table: "missing", format: "csv", columns: ["id"] })).status).toBe(404);
    expect(exportLogs()).toEqual([]);
  });

  it("audits the export once its download has ended, with the rows it wrote", async () => {
    const id = await createConnection();
    await exportText(id, { table: "items", format: "csv", columns: ["id", "name"], sort: [{ column: "id", dir: "ASC" }] });
    const [log] = exportLogs();
    expect(log).toMatchObject({ status: "ok", operation: "select", row_count: 4, actor: "human", error: null });
    expect(log!.sql).toBe('SELECT "id", "name"\nFROM "items"\nORDER BY "id" ASC');
    expect(JSON.parse(log!.params_json!)).toMatchObject({ table: "items", columns: ["id", "name"], format: "csv" });
    expect(JSON.parse(log!.result_head!)).toEqual([
      { id: 1, name: "Apple" }, { id: 2, name: 'say "hi", twice' }, { id: 3, name: "line\nbreak" }, { id: 4, name: "pie" },
    ]);
  });

  it("audits a download stopped halfway, and lets go of the read", async () => {
    const id = await createConnection();
    const started = await startExport(id, { table: "many", format: "csv", columns: ["id", "label"] });
    const res = await download(started.data.ticket);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    // The audit is written by the stream's cancel, which the reader's cancel resolves after.
    const [log] = exportLogs();
    expect(log!.status).toBe("error");
    expect(log!.error).toMatch(/^The download was stopped after [\d,]+ rows$/);
    expect(log!.row_count).toBeLessThan(200_000);
    // The slot it held is free again: as many exports as the limit can be open.
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) {
      expect((await startExport(id, { table: "items", format: "csv", columns: ["id"] })).status).toBe(200);
    }
  });

  it("lets go of an export whose download never starts", async () => {
    const id = await createConnection();
    const started = await startExport(id, { table: "items", format: "csv", columns: ["id"] });
    abandonAllExportTickets();
    expect((await download(started.data.ticket)).status).toBe(404);
    const [log] = exportLogs();
    // Its first rows were read, but none was written to a file.
    expect(log).toMatchObject({ status: "error", error: "The download never started", row_count: 0 });
  });

  it("keeps no more than MAX_OPEN_EXPORTS open at once", async () => {
    const id = await createConnection();
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) {
      expect((await startExport(id, { table: "items", format: "csv", columns: ["id"] })).status).toBe(200);
    }
    const refused = await startExport(id, { table: "items", format: "csv", columns: ["id"] });
    expect(refused.status).toBe(429);
    expect(refused.error).toBe(`${MAX_OPEN_EXPORTS} exports are already running. Export again once one has finished.`);
    abandonAllExportTickets();
    expect((await startExport(id, { table: "items", format: "csv", columns: ["id"] })).status).toBe(200);
  });

  it("gives the slot back when the read cannot start", async () => {
    const id = await createConnection();
    for (let i = 0; i < MAX_OPEN_EXPORTS + 2; i++) {
      expect((await startExport(id, { table: "missing", format: "csv", columns: ["id"] })).status).toBe(404);
    }
    expect((await startExport(id, { table: "items", format: "csv", columns: ["id"] })).status).toBe(200);
  });

  it("refuses a SQL condition that writes on a readonly connection, and audits the refusal", async () => {
    const id = await createConnection(true);
    const res = await startExport(id, {
      table: "items", format: "csv", columns: ["id"],
      filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "(DELETE FROM items) IS NULL" }]] }],
    });
    expect(res.status).toBe(403);
    expect(exportLogs()).toHaveLength(1);
    expect(exportLogs()[0]).toMatchObject({ status: "blocked", source: "export" });
    expect(exportLogs()[0]!.sql).toContain("DELETE FROM items");
  });

  it("lets other requests in while it reads a big table", async () => {
    const id = await createConnection();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const csv = await exportText(id, { table: "many", format: "csv", columns: ["id", "label"] });
      expect(csv.split("\n")).toHaveLength(200_002);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("ends a batch at its bytes, so wide rows are read a few at a time", async () => {
    const target = { type: "sqlite" as const, adapter: getAdapter("sqlite"), config: { type: "sqlite" as const, path: targetDbPath, readonly: false } };
    const req = parseGridExportRequest({ table: "wide", format: "csv", columns: ["id", "body"] }, null);
    const opened = await openGridExport(target, req, { rows: 1000, bytes: 4_500 });
    const sizes: number[] = [];
    for await (const batch of opened.batches) sizes.push(batch.length);
    // A row is about 2 KB (1,000 characters at two bytes each): the batch ends on the third.
    expect(sizes).toEqual([3, 2]);
  });
});

describe("the download's ticket stands in for the token", () => {
  beforeEach(() => {
    configService.set("auth", { enabled: true, token: "export-token" });
    auth = true;
  });
  afterEach(() => {
    configService.set("auth", { enabled: false, token: "" });
    auth = false;
  });

  it("downloads with the ticket alone, and refuses one never issued", async () => {
    auth = false;
    const id = await createConnection();
    auth = true;
    const started = await startExport(id, { table: "items", format: "csv", columns: ["id"] }, { Authorization: "Bearer export-token" });
    expect(started.status).toBe(200);
    expect((await download(started.data.ticket)).status).toBe(200);
    // Spent: from now on the middleware does not let it through at all.
    expect((await download(started.data.ticket)).status).toBe(401);
    expect((await download("A".repeat(43))).status).toBe(401);
  });

  it("still asks POST grid/export for the token", async () => {
    auth = false;
    const id = await createConnection();
    auth = true;
    expect((await startExport(id, { table: "items", format: "csv", columns: ["id"] })).status).toBe(401);
  });
});
