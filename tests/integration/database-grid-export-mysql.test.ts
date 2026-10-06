/**
 * Export ▸ against real MySQL and MariaDB servers: the driver's own values in the files, batches
 * cut by bytes, and that a download stopped or never started leaves no session reading. Runs only
 * when the URLs name disposable servers, e.g.
 *
 *   docker run --rm -d -p 127.0.0.1:23306:3306 -e MYSQL_ROOT_PASSWORD=x mysql:8.4
 *   docker run --rm -d -p 127.0.0.1:23307:3306 -e MARIADB_ROOT_PASSWORD=x mariadb:11
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-grid-export-mysql.test.ts
 *
 * Each run creates one database named after itself on each server and drops it at the end. The
 * driver is installed as Settings installs it, from the repository's own copy (see database-mysql.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import mysql2 from "mysql2/promise";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../src/services/database/adapter-registry.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { abandonAllExportTickets } from "../../src/services/database/grid-export-tickets.ts";
import { parseGridExportRequest } from "../../src/services/database/grid-query-builder.ts";
import { openGridExport, type GridTarget } from "../../src/services/database/grid.service.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { GridExportTicket } from "../../src/shared/db-grid-export.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const ENGINES: { type: Extract<DbType, "mysql" | "mariadb">; url: string | undefined }[] = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

const app = () => new Hono().route("/db", databaseRoutes);
const exportLogs = () => listQueryLogs({ limit: 200 }).filter((l) => l.source === "export");

const settle = async (check: () => Promise<boolean>): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

beforeAll(async () => {
  initAdapters();
  if (ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  await mysqlService.closeAll();
  await readonlyMysqlService.closeAll();
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`export on ${engine.type}`, () => {
    const DB = `ppm_export_${engine.type}_${RUN}`;
    const url = `${engine.url?.replace(/\/$/, "")}/${DB}`;
    let admin: mysql2.Connection;
    let connId = 0;
    const target = (): GridTarget => ({ type: engine.type, adapter: getAdapter(engine.type), config: { type: engine.type, connectionString: url } });

    const startExport = async (body: Record<string, unknown>) => {
      const res = await app().request(`/db/connections/${connId}/grid/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
        body: JSON.stringify({ schema: DB, ...body }),
      });
      const json = (await res.json()) as { data: GridExportTicket; error?: string };
      return { status: res.status, data: json.data, error: json.error };
    };
    const download = (ticket: string) => app().request(`/db/grid-export/${ticket}`);
    const exportText = async (body: Record<string, unknown>) => {
      const started = await startExport(body);
      expect(started.error).toBeUndefined();
      return (await download(started.data.ticket)).text();
    };
    /** Sessions running a statement on this run's database other than the admin's own. */
    const busySessions = async (): Promise<number> => {
      const [rows] = await admin.query(
        "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND DB = ? AND COMMAND <> 'Sleep'",
        [DB],
      );
      return Number((rows as { n: number }[])[0]!.n);
    };

    beforeAll(async () => {
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
      await admin.query(`
        CREATE DATABASE ${DB} CHARACTER SET utf8mb4;
        USE ${DB};
        CREATE TABLE kinds (
          id BIGINT PRIMARY KEY, label VARCHAR(50), amount DECIMAL(30,10), ratio FLOAT, flags BIT(8), active TINYINT(1),
          created DATETIME, photo BLOB
        );
        INSERT INTO kinds VALUES
          (1, 'plain', 1.5, 1.1, b'00000101', 1, '2024-01-01 10:00:00', X'0102'),
          (9007199254740993, 'two\\nlines', 12345678901234567890.1234567891, NULL, NULL, 0, NULL, NULL);
        CREATE TABLE digits (n INT PRIMARY KEY);
        INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);
        CREATE TABLE many (id INT PRIMARY KEY, label VARCHAR(20));
        INSERT INTO many SELECT a.n * 10000 + b.n * 1000 + c.n * 100 + d.n * 10 + e.n + 1, CONCAT('row ', a.n, b.n, c.n, d.n, e.n)
          FROM digits a, digits b, digits c, digits d, digits e WHERE a.n < 5;
        CREATE TABLE wide (id INT PRIMARY KEY, body LONGTEXT);
        INSERT INTO wide SELECT n + 1, REPEAT('x', 400000) FROM digits WHERE n < 6;
        CREATE TABLE counter (n INT NOT NULL);
        INSERT INTO counter VALUES (0);
        CREATE TABLE files (id BIGINT PRIMARY KEY, data LONGBLOB, note LONGTEXT);
        INSERT INTO files VALUES (9007199254740993, REPEAT(X'00FF7F', 400000), REPEAT('đ', 300000));
      `);
      // Declared DETERMINISTIC only so a server with binary logging accepts it from a non-SUPER session.
      await admin.query("CREATE FUNCTION bump() RETURNS INT DETERMINISTIC BEGIN UPDATE counter SET n = n + 1; RETURN 1; END");
      setDb(openTestDb());
      connId = insertConnection(engine.type, `${engine.type}-export`, { type: engine.type, connectionString: url }).id;
      updateConnection(connId, { readonly: 0 });
    });

    beforeEach(() => {
      getAuditDb().exec("DELETE FROM query_log");
    });

    afterEach(() => {
      abandonAllExportTickets();
    });

    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    });

    it("writes the driver's values: exact integers and decimals, BIT as a number, FLOAT as stored", async () => {
      const json = await exportText({
        table: "kinds", format: "json", sort: [{ column: "id", dir: "ASC" }],
        columns: ["id", "label", "amount", "ratio", "flags", "active", "created", "photo"],
      });
      expect(json).toBe(
        "[\n"
        // A DECIMAL comes with its scale's zeros, which a JSON number would drop: it stays text.
        + '{"id":1,"label":"plain","amount":"1.5000000000","ratio":1.1,"flags":5,"active":1,"created":"2024-01-01 10:00:00",'
        + '"photo":{"$binary":"AQI=","size":2}},\n'
        + '{"id":"9007199254740993","label":"two\\nlines","amount":"12345678901234567890.1234567891","ratio":null,"flags":null,'
        + '"active":0,"created":null,"photo":null}\n'
        + "]\n",
      );
    });

    it("spells SQL values the way MySQL reads them back", async () => {
      const sql = await exportText({ table: "kinds", format: "sql", sort: [{ column: "id", dir: "ASC" }], columns: ["id", "amount", "photo"] });
      expect(sql).toBe(
        "INSERT INTO `kinds` (`id`, `amount`, `photo`) VALUES (1, 1.5000000000, X'0102');\n"
        + "INSERT INTO `kinds` (`id`, `amount`, `photo`) VALUES (9007199254740993, 12345678901234567890.1234567891, NULL);\n",
      );
    });

    it("reads every row in order through the stream", async () => {
      const csv = await exportText({ table: "many", format: "csv", columns: ["id"], sort: [{ column: "id", dir: "ASC" }] });
      const lines = csv.trimEnd().split("\n");
      expect(lines).toHaveLength(50_001);
      expect(lines[1]).toBe("1");
      expect(lines[50_000]).toBe("50000");
    });

    it("ends a batch at its bytes", async () => {
      const req = parseGridExportRequest({ table: "wide", schema: DB, format: "csv", columns: ["id", "body"] }, null);
      const opened = await openGridExport(target(), req, { rows: 1000, bytes: 1_000_000 });
      const sizes: number[] = [];
      for await (const batch of opened.batches) sizes.push(batch.length);
      // A row is 800 KB: the second one takes a batch past 1 MB, and it ends there.
      expect(sizes).toEqual([2, 2, 2]);
    });

    it("ends the database session when the download is stopped", async () => {
      const started = await startExport({ table: "many", format: "csv", columns: ["id", "label"] });
      const reader = (await download(started.data.ticket)).body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      expect(await settle(async () => (await busySessions()) === 0)).toBe(true);
      expect(exportLogs()[0]!.error).toMatch(/^The download was stopped after [\d,]+ rows$/);
    });

    it("ends the database session of an export nobody downloads", async () => {
      await startExport({ table: "many", format: "csv", columns: ["id", "label"] });
      abandonAllExportTickets();
      expect(await settle(async () => (await busySessions()) === 0)).toBe(true);
      expect(exportLogs()[0]).toMatchObject({ status: "error", error: "The download never started" });
    });

    it("saves a cell's bytes and text whole for Save cell to file, its row found by a key past 2^53", async () => {
      const startCell = async (column: string) => {
        const res = await app().request(`/db/connections/${connId}/grid/cell`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
          // The key as the grid holds it: a BIGINT past 2^53 arrives as text.
          body: JSON.stringify({ schema: DB, table: "files", column, key: { id: "9007199254740993" }, fileName: `files-${column}.bin` }),
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

    it("reads inside a READ ONLY transaction: a function that writes fails, and writes nothing", async () => {
      const req = parseGridExportRequest({
        table: "kinds", schema: DB, format: "csv", columns: ["id"],
        filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: "$$ > bump()" }]] }],
      }, null);
      await expect(openGridExport(target(), req)).rejects.toThrow("Cannot execute statement in a READ ONLY transaction");
      const [rows] = await admin.query("SELECT n FROM counter");
      expect((rows as { n: number }[])[0]!.n).toBe(0);
    });
  });
}
