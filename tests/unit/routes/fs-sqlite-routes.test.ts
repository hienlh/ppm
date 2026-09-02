import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { fsSqliteRoutes } from "../../../src/server/routes/fs-sqlite.ts";
import { sqliteService } from "../../../src/services/sqlite.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const app = new Hono().route("/fs/sqlite", fsSqliteRoutes);
let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-sqlite-"));
  dbPath = join(dir, "external.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.exec("INSERT INTO notes (body) VALUES ('first'), ('second')");
  db.close();
});

afterAll(() => {
  sqliteService.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setDb(openTestDb());
});

const q = (path: string) => encodeURIComponent(path);

describe("external SQLite browsing", () => {
  it("lists tables of a database outside any project", async () => {
    const res = await app.request(`/fs/sqlite/tables?path=${q(dbPath)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([{ name: "notes", rowCount: 2 }]);
  });

  it("returns the table schema", async () => {
    const res = await app.request(`/fs/sqlite/schema?path=${q(dbPath)}&table=notes`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.map((c: { name: string }) => c.name)).toEqual(["id", "body"]);
  });

  it("returns paginated rows", async () => {
    const res = await app.request(`/fs/sqlite/data?path=${q(dbPath)}&table=notes&limit=1`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total).toBe(2);
    expect(json.data.rows).toHaveLength(1);
  });

  it("runs a query", async () => {
    const res = await app.request("/fs/sqlite/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dbPath, sql: "SELECT COUNT(*) AS n FROM notes" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.rows[0].n).toBe(2);
  });

  it("validates required parameters", async () => {
    expect((await app.request("/fs/sqlite/tables")).status).toBe(400);
    expect((await app.request(`/fs/sqlite/schema?path=${q(dbPath)}`)).status).toBe(400);
  });
});

const post = (body: unknown) =>
  app.request("/fs/sqlite/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("arbitrary SQL door", () => {
  it("rejects ATTACH, which would open a second database on the cached connection", async () => {
    const target = join(dir, "attached.db");
    const res = await post({ path: dbPath, sql: `ATTACH DATABASE '${target}' AS p` });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("EINVAL");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects ATTACH hidden behind a comment and a leading statement", async () => {
    const res = await post({
      path: dbPath,
      sql: `SELECT 1; /* x */ attach database '${join(dir, "sneaky.db")}' as p`,
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, "sneaky.db"))).toBe(false);
  });

  it("rejects DETACH", async () => {
    const res = await post({ path: dbPath, sql: "DETACH DATABASE p" });
    expect(res.status).toBe(400);
  });

  it("still runs a query mentioning the word in a literal", async () => {
    const res = await post({ path: dbPath, sql: "SELECT 'attach' AS label" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.rows[0].label).toBe("attach");
  });

  it("caps the row count of a large result", async () => {
    const res = await post({
      path: dbPath,
      sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000) SELECT i FROM n",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.rows).toHaveLength(1000);
    expect(json.data.truncated).toBe(true);
  });
});

describe("guards", () => {
  it("refuses the PPM config database", async () => {
    writeFileSync(resolve(getPpmDir(), "ppm.db"), "");
    const res = await app.request(`/fs/sqlite/tables?path=${q(resolve(getPpmDir(), "ppm.db"))}`);
    expect(res.status).toBe(403);
  });

  it("refuses a symlink pointing at the PPM config database", async () => {
    const secret = resolve(getPpmDir(), "ppm.db");
    writeFileSync(secret, "");
    const link = join(dir, "innocent.db");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // link creation needs privileges on some hosts
    }
    const res = await app.request(`/fs/sqlite/tables?path=${q(link)}`);
    expect(res.status).toBe(403);
  });

  it.if(process.platform === "win32")("refuses a UNC path, which is unsupported", async () => {
    const res = await app.request(`/fs/sqlite/tables?path=${q("\\\\server\\share\\x.db")}`);
    expect(res.status).toBe(403);
  });

  it("answers 404 for a missing database file and does not create it", async () => {
    const missing = join(dir, "missing.db");
    const res = await app.request(`/fs/sqlite/tables?path=${q(missing)}`);
    expect(res.status).toBe(404);
    expect(existsSync(missing)).toBe(false);
  });
});
