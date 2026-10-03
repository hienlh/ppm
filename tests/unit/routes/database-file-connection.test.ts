/**
 * A SQLite file opened from the editor or a file explorer, served by the connection routes under
 * the id `file` with the path on every request. The guards of the two viewers it replaced — the
 * filesystem door (`/api/fs/sqlite`, absolute paths, rows capped) and the project door (`/sqlite`,
 * paths inside a project) — must hold on the new one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDb, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { sqliteService } from "../../../src/services/sqlite.service.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { closeAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { abandonAllExportTickets } from "../../../src/services/database/grid-export-tickets.ts";
import { listQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { assertIsolatedPpmHome } from "../../helpers/assert-isolated-ppm-home.ts";

const app = new Hono().route("/db", databaseRoutes);
let dir: string;
let dbPath: string;
let projectDir: string;

beforeAll(() => {
  initAdapters();
  dir = mkdtempSync(join(tmpdir(), "db-file-conn-"));
  dbPath = join(dir, "external.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.exec("INSERT INTO notes (body) VALUES ('first'), ('second')");
  db.close();

  projectDir = join(dir, "proj");
  mkdirSync(join(projectDir, "data"), { recursive: true });
  const inner = new Database(join(projectDir, "data", "app.db"));
  inner.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  inner.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) INSERT INTO items (name) SELECT 'item ' || i FROM n");
  inner.close();
});

afterAll(() => {
  sqliteService.closeAll();
  closeAuditDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  (configService as unknown as { config: { projects: { name: string; path: string }[] } }).config.projects = [
    { name: "proj", path: projectDir },
  ];
});

const q = encodeURIComponent;
const external = (path = dbPath) => `path=${q(path)}`;
const inProject = (path = "data/app.db") => `project=proj&path=${q(path)}`;

function post(url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json", "x-ppm-client": "web" }, body: JSON.stringify(body) });
}

describe("a database file outside every project", () => {
  it("lists its tables without writing the table cache, which belongs to saved connections", async () => {
    const res = await app.request(`/db/connections/file/tables?${external()}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { name: string; rowCount: number }[] };
    expect(json.data.map((t) => [t.name, t.rowCount])).toEqual([["notes", 2]]);
    expect((getDb().query("SELECT COUNT(*) AS n FROM connection_table_cache").get() as { n: number }).n).toBe(0);
  });

  it("serves the grid, the structure and the SQL tab like a saved connection", async () => {
    const grid = await post(`/db/connections/file/grid?${external()}`, { table: "notes", filters: [], sort: [], offset: 0, limit: 1 });
    expect(grid.status).toBe(200);
    const page = (await grid.json() as { data: { rows: unknown[][]; hasMore: boolean } }).data;
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(true);

    // What a new row's key cell reads: `id` is the rowid, which SQLite numbers itself.
    const columns = await app.request(`/db/connections/file/schema?${external()}&table=notes`);
    expect((await columns.json() as { data: { name: string; autoIncrement: boolean }[] }).data.map((c) => [c.name, c.autoIncrement]))
      .toEqual([["id", true], ["body", false]]);

    const structure = await app.request(`/db/connections/file/structure?${external()}&table=notes`);
    expect(structure.status).toBe(200);
    expect((await structure.json() as { data: { columns: { name: string }[] } }).data.columns.map((c) => c.name)).toEqual(["id", "body"]);

    const sql = await app.request(`/db/connections/file/object-sql?${external()}&kind=table&name=notes`);
    expect(sql.status).toBe(200);
    const scripts = (await sql.json() as { data: { create: string; select: string; insert: string } }).data;
    expect(scripts.create).toBe("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
    expect(scripts.select).toBe('SELECT "id", "body"\nFROM "notes";');
    expect(scripts.insert).toBe('INSERT INTO "notes" ("body")\nVALUES (?);');
  });

  it("caps the rows a query returns, keeping repeated column names", async () => {
    const res = await post(`/db/connections/file/query?${external()}`, {
      sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) SELECT i, i * 2 AS i FROM n",
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { columns: { name: string }[]; rows: unknown[][]; truncated?: boolean } };
    expect(json.data.rows).toHaveLength(1000);
    expect(json.data.truncated).toBe(true);
    expect(json.data.columns.map((c) => c.name)).toEqual(["i", "i"]);
    expect(json.data.rows[999]).toEqual([1000, 2000]);
  });

  it("caps a statement that cannot be wrapped as a subquery, and runs it once", async () => {
    const res = await post(`/db/connections/file/query?${external()}`, { sql: "PRAGMA table_info(notes)" });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { rows: unknown[][] } }).data.rows).toHaveLength(2);

    const insert = await post(`/db/connections/file/query?${external()}`, { sql: "INSERT INTO notes (body) VALUES ('third') RETURNING id" });
    expect(insert.status).toBe(200);
    expect((await insert.json() as { data: { rows: unknown[][] } }).data.rows).toEqual([[3]]);
    const count = await post(`/db/connections/file/query?${external()}`, { sql: "SELECT COUNT(*) FROM notes" });
    expect((await count.json() as { data: { rows: unknown[][] } }).data.rows).toEqual([[3]]);
    await post(`/db/connections/file/query?${external()}`, { sql: "DELETE FROM notes WHERE id = 3" });
  });

  it("logs a query under the file's path, with no connection id", async () => {
    assertIsolatedPpmHome();
    await post(`/db/connections/file/query?${external()}`, { sql: "SELECT body FROM notes" });
    const log = listQueryLogs({ limit: 1 }).find((l) => l.sql === "SELECT body FROM notes");
    expect(log?.connection_id ?? null).toBeNull();
    expect(log?.connection_name).toBe(dbPath);
  });
});

describe("a database file inside a project", () => {
  it("resolves the path against the project and reads every row", async () => {
    const res = await post(`/db/connections/file/query?${inProject()}`, { sql: "SELECT id FROM items" });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { rows: unknown[][]; truncated?: boolean } };
    expect(json.data.rows).toHaveLength(1500);
    expect(json.data.truncated).toBeUndefined();
  });

  it("refuses a path that leaves the project", async () => {
    const res = await app.request(`/db/connections/file/tables?${inProject("../external.db")}`);
    expect(res.status).toBe(403);
  });

  describe("GET /data", () => {
    const read = async (query: string, path = "data/app.db") => {
      const res = await app.request(`/db/connections/file/data?${inProject(path)}&${query}`);
      const json = await res.json() as { data?: { rows: Record<string, unknown>[] } };
      return { status: res.status, rows: json.data?.rows };
    };

    it("pages at most 1000 rows, and at least one", async () => {
      expect((await read("table=items&limit=5000")).rows).toHaveLength(1000);
      expect((await read("table=items&limit=-1")).rows).toHaveLength(1);
    });

    it("sorts descending only for DESC, and ascending for any other direction", async () => {
      expect((await read("table=items&limit=2&orderBy=id&orderDir=DESC")).rows?.map((r) => r.id)).toEqual([1500, 1499]);
      expect((await read("table=items&limit=2&orderBy=id&orderDir=sideways")).rows?.map((r) => r.id)).toEqual([1, 2]);
    });

    it("reads a table and sorts by a column whose names hold a double quote", async () => {
      const file = new Database(join(projectDir, "data", "names.db"));
      file.exec('CREATE TABLE "say ""hi""" ("the ""id""" INTEGER); INSERT INTO "say ""hi""" VALUES (1), (3), (2)');
      file.close();
      const res = await read(`table=${q('say "hi"')}&orderBy=${q('the "id"')}&orderDir=DESC`, "data/names.db");
      expect(res.status).toBe(200);
      expect(res.rows?.map((r) => r['the "id"'])).toEqual([3, 2, 1]);
    });
  });

  it("exports every row of it, and refuses to export one outside it", async () => {
    try {
      const body = { table: "items", format: "csv", columns: ["id", "name"], sort: [{ column: "id", dir: "DESC" }] };
      const started = await post(`/db/connections/file/grid/export?${inProject()}`, body);
      expect(started.status).toBe(200);
      const { data } = await started.json() as { data: { ticket: string; fileName: string } };
      expect(data.fileName).toBe("items.csv");
      const lines = (await (await app.request(`/db/grid-export/${data.ticket}`)).text()).trimEnd().split("\n");
      expect(lines).toHaveLength(1501);
      expect(lines.slice(0, 2)).toEqual(["id,name", "1500,item 1500"]);
      expect((await post(`/db/connections/file/grid/export?${inProject("../external.db")}`, body)).status).toBe(403);
    } finally {
      abandonAllExportTickets();
    }
  });

  it("saves a cell of it whole, and refuses to read one outside it", async () => {
    try {
      const body = { table: "items", column: "name", key: { id: 7 }, fileName: "items-name.txt" };
      const started = await post(`/db/connections/file/grid/cell?${inProject()}`, body);
      expect(started.status).toBe(200);
      const { data } = await started.json() as { data: { ticket: string; fileName: string } };
      expect(await (await app.request(`/db/grid-export/${data.ticket}`)).text()).toBe("item 7");
      expect((await post(`/db/connections/file/grid/cell?${inProject("../external.db")}`, body)).status).toBe(403);
    } finally {
      abandonAllExportTickets();
    }
  });

  it("answers 404 for a project it does not know", async () => {
    const res = await app.request(`/db/connections/file/tables?project=nope&path=${q("data/app.db")}`);
    expect(res.status).toBe(404);
  });

  it("refuses a link inside the project that points at the PPM directory", async () => {
    assertIsolatedPpmHome();
    const secret = resolve(getPpmDir(), "ppm.db");
    writeFileSync(secret, "");
    const link = join(projectDir, "data", "innocent.db");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // link creation needs privileges on some hosts
    }
    const res = await app.request(`/db/connections/file/tables?${inProject("data/innocent.db")}`);
    expect(res.status).toBe(403);
  });
});

describe("SQL typed against a database file", () => {
  it("rejects ATTACH, which would open a second database on the cached connection", async () => {
    const target = join(dir, "attached.db");
    const res = await post(`/db/connections/file/query?${external()}`, { sql: `ATTACH DATABASE '${target}' AS p` });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe("EINVAL");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects ATTACH hidden behind a comment and a leading statement", async () => {
    const res = await post(`/db/connections/file/query?${external()}`, { sql: `SELECT 1; /* x */ attach database '${join(dir, "sneaky.db")}' as p` });
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, "sneaky.db"))).toBe(false);
  });

  it("rejects DETACH", async () => {
    expect((await post(`/db/connections/file/query?${external()}`, { sql: "DETACH DATABASE p" })).status).toBe(400);
  });

  it("still runs a query mentioning the word in a literal", async () => {
    const res = await post(`/db/connections/file/query?${external()}`, { sql: "SELECT 'attach' AS label" });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { rows: unknown[][] } }).data.rows).toEqual([["attach"]]);
  });
});

describe("guards", () => {
  it("wants a path, and an absolute one outside a project", async () => {
    expect((await app.request("/db/connections/file/tables")).status).toBe(400);
    expect((await app.request(`/db/connections/file/tables?path=${q("external.db")}`)).status).toBe(400);
  });

  it("refuses the PPM config database", async () => {
    assertIsolatedPpmHome();
    writeFileSync(resolve(getPpmDir(), "ppm.db"), "");
    const res = await app.request(`/db/connections/file/tables?${external(resolve(getPpmDir(), "ppm.db"))}`);
    expect(res.status).toBe(403);
  });

  it("refuses a symlink pointing at the PPM config database", async () => {
    assertIsolatedPpmHome();
    const secret = resolve(getPpmDir(), "ppm.db");
    writeFileSync(secret, "");
    const link = join(dir, "innocent.db");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // link creation needs privileges on some hosts
    }
    const res = await app.request(`/db/connections/file/tables?${external(link)}`);
    expect(res.status).toBe(403);
  });

  it.if(process.platform === "win32")("refuses a UNC path, which is unsupported", async () => {
    const res = await app.request(`/db/connections/file/tables?${external("\\\\server\\share\\x.db")}`);
    expect(res.status).toBe(403);
  });

  it("answers 404 for a missing database file and does not create it", async () => {
    const missing = join(dir, "missing.db");
    const res = await app.request(`/db/connections/file/tables?${external(missing)}`);
    expect(res.status).toBe(404);
    expect(existsSync(missing)).toBe(false);
  });

  it("names no other database", async () => {
    const res = await app.request(`/db/connections/file/objects?${external()}&database=main`);
    expect(res.status).toBe(400);
  });

  it("is no saved connection: it cannot be read, edited, copied or deleted as one", async () => {
    const qs = external();
    expect((await app.request(`/db/connections/file?${qs}`)).status).toBe(404);
    expect((await app.request(`/db/connections/file/config?${qs}`)).status).toBe(404);
    expect((await app.request(`/db/connections/file/duplicate?${qs}`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/db/connections/file/test?${qs}`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/db/connections/file?${qs}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }),
    })).status).toBe(404);
    expect((await app.request(`/db/connections/file?${qs}`, { method: "DELETE" })).status).toBe(404);
  });
});
