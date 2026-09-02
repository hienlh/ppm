import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("guards", () => {
  it("refuses the PPM config database", async () => {
    const res = await app.request(`/fs/sqlite/tables?path=${q(resolve(getPpmDir(), "ppm.db"))}`);
    expect(res.status).toBe(403);
  });

  it.if(process.platform === "win32")("refuses a UNC path, which is unsupported", async () => {
    const res = await app.request(`/fs/sqlite/tables?path=${q("\\\\server\\share\\x.db")}`);
    expect(res.status).toBe(403);
  });

  it("answers 500 for a missing database file", async () => {
    const res = await app.request(`/fs/sqlite/tables?path=${q(join(dir, "missing.db"))}`);
    expect(res.status).toBe(500);
  });
});
