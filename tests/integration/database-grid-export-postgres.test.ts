/**
 * Export ▸ against a real Postgres: the driver's own values in each format, the cursor's fetch
 * counts, and that a download stopped, failed or never started leaves no session behind. Runs only
 * when `PPM_TEST_PG_URL` names a disposable database, e.g.
 *
 *   docker run --rm -d -p 25432:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres bun test tests/integration/database-grid-export-postgres.test.ts
 *
 * Everything it creates lives in one schema named after this run and is dropped at the end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { abandonAllExportTickets } from "../../src/services/database/grid-export-tickets.ts";
import { parseGridExportRequest } from "../../src/services/database/grid-query-builder.ts";
import { openGridExport, type GridTarget } from "../../src/services/database/grid.service.ts";
import { postgresService } from "../../src/services/postgres.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { GridExportTicket } from "../../src/shared/db-grid-export.ts";
import { readZip } from "../helpers/read-zip.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const S = `ppm_export_${RUN}`;

const app = () => new Hono().route("/db", databaseRoutes);
let connId = 0;

async function startExport(body: Record<string, unknown>) {
  const res = await app().request(`/db/connections/${connId}/grid/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify({ schema: S, ...body }),
  });
  const json = (await res.json()) as { data: GridExportTicket; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

const download = (ticket: string) => app().request(`/db/grid-export/${ticket}`);

async function exportText(body: Record<string, unknown>): Promise<string> {
  const started = await startExport(body);
  expect(started.error).toBeUndefined();
  return (await download(started.data.ticket)).text();
}

const exportLogs = () => listQueryLogs({ limit: 200 }).filter((l) => l.source === "export");

describe.skipIf(!PG_URL)("export on Postgres", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const target = (): GridTarget => ({ type: "postgres", adapter: getAdapter("postgres"), config: { type: "postgres", connectionString: PG_URL! } });

  /** Sessions still reading an export: its cursor is named in what they run. */
  const exportSessions = async (): Promise<number> => {
    const [row] = await admin!`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND (query ILIKE '%ppm_export%') AND state <> 'idle'
    `;
    return (row as { n: number }).n;
  };
  const settle = async (check: () => Promise<boolean>): Promise<boolean> => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  beforeAll(async () => {
    initAdapters();
    setDb(openTestDb());
    await admin!.unsafe(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.kinds (
        id int8 PRIMARY KEY, label text, n numeric, f float8, j jsonb, b bytea, ts timestamp, u uuid, ok boolean, tags int[]
      );
      INSERT INTO ${S}.kinds VALUES
        (1, 'plain', 1.5, 0.1, '{"k": [1, 2]}', '\\x0102', '2024-01-01 10:00:00', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', true, '{1,2}'),
        (9007199254740993, E'two\\nlines', 12345678901234567890.1234567891, 'NaN', NULL, NULL, NULL, NULL, false, NULL);
      CREATE TABLE ${S}.many AS SELECT g AS id, 'row ' || g AS label FROM generate_series(1, 50000) g;
      CREATE TABLE ${S}.wide AS SELECT g AS id, repeat('x', 400000) AS body FROM generate_series(1, 6) g;
      CREATE TABLE ${S}.files (id int8 PRIMARY KEY, data bytea, note text);
      CREATE TABLE ${S}.docs (id int PRIMARY KEY, j jsonb, t json, ja jsonb[]);
      INSERT INTO ${S}.docs VALUES
        (1, '"just text"', '"just text"', ARRAY['{"a": 1}', '"s"']::jsonb[]),
        (2, '12345678901234567890', '12345678901234567890', NULL), (3, '"123"', '{"a":  1}', NULL), (4, 'null', NULL, NULL);
      INSERT INTO ${S}.files VALUES (9007199254740993, decode(repeat('00ff7f', 400000), 'hex'), repeat('đ', 300000));
    `);
    const res = await app().request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "postgres", name: "export-pg", connectionConfig: { type: "postgres", connectionString: PG_URL } }),
    });
    connId = ((await res.json()) as { data: { id: number } }).data.id;
  });

  beforeEach(() => {
    getAuditDb().exec("DELETE FROM query_log");
  });

  afterEach(() => {
    abandonAllExportTickets();
  });

  afterAll(async () => {
    await postgresService.closeAll();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin!.end();
  });

  it("writes the driver's values: exact integers and decimals, whole bytes, raw timestamps", async () => {
    const json = await exportText({
      table: "kinds", format: "json", sort: [{ column: "id", dir: "ASC" }],
      columns: ["id", "label", "n", "f", "j", "b", "ts", "u", "ok", "tags"],
    });
    expect(json).toBe(
      "[\n"
      + '{"id":1,"label":"plain","n":1.5,"f":0.1,"j":{"k": [1, 2]},"b":{"$binary":"AQI=","size":2},'
      + '"ts":"2024-01-01 10:00:00","u":"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11","ok":true,"tags":[1,2]},\n'
      + '{"id":"9007199254740993","label":"two\\nlines","n":"12345678901234567890.1234567891","f":"NaN","j":null,"b":null,'
      + '"ts":null,"u":null,"ok":false,"tags":null}\n'
      + "]\n",
    );
  });

  it("writes a json column as the document Postgres holds: a string, a number past 2^53, JSON null", async () => {
    const body = { table: "docs", sort: [{ column: "id", dir: "ASC" }], columns: ["id", "j", "t"] };
    expect(await exportText({ ...body, format: "csv" })).toBe(
      'id,j,t\n1,"""just text""","""just text"""\n2,12345678901234567890,12345678901234567890\n3,"""123""","{""a"":  1}"\n4,null,\n',
    );
    expect(await exportText({ ...body, format: "json" })).toBe(
      "[\n"
      + '{"id":1,"j":"just text","t":"just text"},\n'
      + '{"id":2,"j":12345678901234567890,"t":12345678901234567890},\n'
      + '{"id":3,"j":"123","t":{"a":  1}},\n'
      + '{"id":4,"j":null,"t":null}\n'
      + "]\n",
    );
    expect(await exportText({ ...body, format: "sql", columns: ["id", "j"] })).toContain(`VALUES (1, '"just text"');`);
    // An array of them is still read into values, as every other array is.
    expect(await exportText({ ...body, format: "json", columns: ["id", "ja"] })).toStartWith('[\n{"id":1,"ja":[{"a":1},"s"]},\n');
  });

  it("spells SQL values the way Postgres reads them back", async () => {
    const sql = await exportText({ table: "kinds", format: "sql", sort: [{ column: "id", dir: "ASC" }], columns: ["id", "n", "b", "ok"] });
    expect(sql).toBe(
      `INSERT INTO "kinds" ("id", "n", "b", "ok") VALUES (1, 1.5, '\\x0102', TRUE);\n`
      + `INSERT INTO "kinds" ("id", "n", "b", "ok") VALUES (9007199254740993, 12345678901234567890.1234567891, NULL, FALSE);\n`,
    );
  });

  it("writes Excel numbers only where Excel keeps them exact", async () => {
    const started = await startExport({ table: "kinds", format: "xlsx", sort: [{ column: "id", dir: "ASC" }], columns: ["id", "n"] });
    const zip = readZip(new Uint8Array(await (await download(started.data.ticket)).arrayBuffer()));
    const sheet = zip.get("xl/worksheets/sheet1.xml")!.toString();
    expect(sheet).toContain('<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>1.5</v></c></row>');
    expect(sheet).toContain(
      '<row r="3"><c r="A3" t="inlineStr"><is><t>9007199254740993</t></is></c>'
      + '<c r="B3" t="inlineStr"><is><t>12345678901234567890.1234567891</t></is></c></row>',
    );
  });

  it("asks a cursor for more rows each time, up to a thousand", async () => {
    const req = parseGridExportRequest({ table: "many", schema: S, format: "csv", columns: ["id"], sort: [{ column: "id", dir: "ASC" }] }, "public");
    const opened = await openGridExport(target(), req);
    const sizes: number[] = [];
    let last = 0;
    for await (const batch of opened.batches) {
      sizes.push(batch.length);
      for (const [id] of batch) expect(Number(id)).toBe(++last);
    }
    expect(sizes.slice(0, 12)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000, 1000]);
    expect(last).toBe(50_000);
  });

  it("fetches wide rows one at a time", async () => {
    const req = parseGridExportRequest({ table: "wide", schema: S, format: "csv", columns: ["id", "body"] }, "public");
    // A row is 800 KB here (400,000 characters at two bytes each), past the 500 KB a batch may hold.
    const opened = await openGridExport(target(), req, { rows: 1000, bytes: 500_000 });
    const sizes: number[] = [];
    for await (const batch of opened.batches) sizes.push(batch.length);
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("answers a statement the database refuses as an error, before any download", async () => {
    const res = await startExport({
      table: "kinds", format: "csv", columns: ["id"], filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "$$ / 0 = 1" }]] }],
    });
    expect(res.status).toBe(500);
    expect(res.error).toBe("division by zero");
    expect(exportLogs()[0]).toMatchObject({ status: "error", error: "division by zero" });
    expect(await settle(async () => (await exportSessions()) === 0)).toBe(true);
  });

  it("fails the download when the database fails halfway, and audits why", async () => {
    // Unsorted, the rows come in the order they were written, each tested only when it is
    // fetched: rows 1..4 come back in the first fetches, and the one reaching row 5 divides by
    // zero. A sort would read every row before returning the first, failing at the start.
    const started = await startExport({
      table: "many", format: "csv", columns: ["id"],
      filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "1 / ($$ - 5) IS NOT NULL" }]] }],
    });
    expect(started.status).toBe(200);
    const res = await download(started.data.ticket);
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow("division by zero");
    expect(exportLogs()[0]).toMatchObject({ status: "error", error: "division by zero" });
  });

  it("ends the database session when the download is stopped", async () => {
    const started = await startExport({ table: "many", format: "csv", columns: ["id", "label"] });
    const reader = (await download(started.data.ticket)).body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(await settle(async () => (await exportSessions()) === 0)).toBe(true);
    expect(exportLogs()[0]!.error).toMatch(/^The download was stopped after [\d,]+ rows$/);
  });

  it("ends the database session of an export nobody downloads", async () => {
    await startExport({ table: "many", format: "csv", columns: ["id", "label"] });
    abandonAllExportTickets();
    expect(await settle(async () => (await exportSessions()) === 0)).toBe(true);
    expect(exportLogs()[0]).toMatchObject({ status: "error", error: "The download never started" });
  });

  it("saves a cell's bytes and text whole for Save cell to file, its row found by a key past 2^53", async () => {
    const startCell = async (column: string) => {
      const res = await app().request(`/db/connections/${connId}/grid/cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
        // The key as the grid holds it: a bigint past 2^53 arrives as text.
        body: JSON.stringify({ schema: S, table: "files", column, key: { id: "9007199254740993" }, fileName: `files-${column}.bin` }),
      });
      return (await res.json()) as { data: GridExportTicket; error?: string };
    };
    const bytes = await startCell("data");
    expect(bytes.error).toBeUndefined();
    const got = Buffer.from(await (await download(bytes.data.ticket)).arrayBuffer());
    expect(got.equals(Buffer.from("00ff7f".repeat(400000), "hex"))).toBe(true);
    const text = await startCell("note");
    expect(await (await download(text.data.ticket)).text()).toBe("đ".repeat(300000));
  });

  it("reads inside a READ ONLY transaction, even on a connection that may write", async () => {
    const req = parseGridExportRequest({
      table: "kinds", schema: S, format: "csv", columns: ["id"],
      filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "$$ > 0 AND current_setting('transaction_read_only') = 'on'" }]] }],
    }, "public");
    const opened = await openGridExport(target(), req);
    const ids: unknown[] = [];
    for await (const batch of opened.batches) ids.push(...batch.map((r) => r[0]));
    expect(ids).toHaveLength(2);
  });
});
