/**
 * A readonly SQLite connection is refused by the file handle itself, not only
 * by reading the SQL: `PRAGMA user_version = 5` reads like a read and writes
 * the database header. Postgres has the same tests against a real server in
 * tests/integration/database-readonly-postgres.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Command } from "commander";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../../../src/services/db.service.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { ReadonlyViolationError } from "../../../../src/services/database/db-errors.ts";
import { readonlySqliteService, sqliteService } from "../../../../src/services/sqlite.service.ts";
import { databaseRoutes } from "../../../../src/server/routes/database.ts";
import { registerDbCommands } from "../../../../src/cli/commands/db-cmd.ts";
import { getAuditDb } from "../../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../../src/services/query-audit/query-audit.service.ts";

const tempDirs: string[] = [];
const app = () => new Hono().route("/db", databaseRoutes);

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-readonly-"));
  tempDirs.push(dir);
  const path = join(dir, "target.db");
  const db = new Database(path);
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO people VALUES (1, 'a');");
  db.close();
  return path;
}

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try { return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version; } finally { db.close(); }
}

function connection(path: string, readonly: boolean): number {
  const conn = insertConnection("sqlite", `ro-${tempDirs.length}-${readonly}`, { type: "sqlite", path });
  if (!readonly) updateConnection(conn.id, { readonly: 0 });
  return conn.id;
}

async function query(id: number, sql: string): Promise<{ status: number; error?: string }> {
  const res = await app().request(`/db/connections/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const json = (await res.json()) as { error?: string };
  return { status: res.status, error: json.error };
}

beforeEach(() => {
  initAdapters();
  setDb(openTestDb());
  getAuditDb().exec("DELETE FROM query_log");
});

afterAll(() => {
  sqliteService.closeAll();
  readonlySqliteService.closeAll();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("readonly SQLite connection", () => {
  it("is refused by the file handle for a write that reads like a read, and audited as blocked", async () => {
    const path = seed();
    const id = connection(path, true);
    const res = await query(id, "PRAGMA user_version = 5");
    expect(res.status).toBe(403);
    expect(res.error).toContain("attempt to write a readonly database");
    expect(userVersion(path)).toBe(0);
    const [log] = listQueryLogs({ connectionId: id });
    expect(log).toMatchObject({ status: "blocked", sql: "PRAGMA user_version = 5" });
  });

  it("runs the same statement on a writable connection, so the refusal is the readonly handle's", async () => {
    const path = seed();
    const res = await query(connection(path, false), "PRAGMA user_version = 5");
    expect(res.status).toBe(200);
    expect(userVersion(path)).toBe(5);
  });

  it("still answers reads", async () => {
    const res = await app().request(`/db/connections/${connection(seed(), true)}/query`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: "SELECT name FROM people" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { rows: unknown[] } }).data.rows).toEqual([["a"]]);
  });

  it("refuses an UPDATE at the file even when nothing checked the SQL first", () => {
    const path = seed();
    // The grid's statements are built by the server and skip the SQL check; the handle is what stops them.
    expect(() => readonlySqliteService.selectRows(path, path, { sql: "UPDATE people SET name = 'x'", params: [] }))
      .toThrow("attempt to write a readonly database");
    expect(() => readonlySqliteService.executeQuery(path, path, "UPDATE people SET name = 'x'")).toThrow(ReadonlyViolationError);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT name FROM people").all()).toEqual([{ name: "a" }]); } finally { db.close(); }
  });
});

describe("ppm db query", () => {
  let exit: ReturnType<typeof spyOn>;
  let out: string[];
  let errors: string[];

  beforeEach(() => {
    out = [];
    errors = [];
    exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
    spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  });

  afterEach(() => {
    exit.mockRestore();
    (console.log as unknown as { mockRestore(): void }).mockRestore();
    (console.error as unknown as { mockRestore(): void }).mockRestore();
  });

  const run = (...args: string[]) => {
    const program = new Command();
    registerDbCommands(program);
    return program.parseAsync(["db", ...args], { from: "user" });
  };

  it("still runs a query on a writable connection as before", async () => {
    const path = seed();
    const id = connection(path, false);
    await run("query", String(id), "UPDATE people SET name = 'b' WHERE id = 1");
    expect(out.join("\n")).toContain("1 row(s) affected");
    await run("query", String(id), "SELECT name FROM people", "--json");
    expect(JSON.parse(out.at(-1)!).rows).toEqual([{ name: "b" }]);
    expect(listQueryLogs({ connectionId: id }).map((l) => [l.source, l.status])).toEqual([["cli", "ok"], ["cli", "ok"]]);
  });

  it("is refused by the file handle on a readonly connection and audits the attempt", async () => {
    const path = seed();
    const id = connection(path, true);
    await expect(run("query", String(id), "PRAGMA user_version = 7")).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("attempt to write a readonly database");
    expect(userVersion(path)).toBe(0);
    expect(listQueryLogs({ connectionId: id })[0]).toMatchObject({ source: "cli", status: "blocked" });
  });
});
