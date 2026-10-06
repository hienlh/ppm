/**
 * Import's writer on a real SQLite file: one transaction on a handle of its own, which a commit
 * keeps and anything else takes back whole — the table it created included.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../../../../src/services/database/adapter-registry.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { ReadonlyViolationError } from "../../../../src/services/database/db-errors.ts";
import type { DbConnectionConfig } from "../../../../src/types/database.ts";

initAdapters();
const dirs: string[] = [];

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-write-session-"));
  dirs.push(dir);
  const path = join(dir, "data.db");
  const db = new Database(path);
  db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
  db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
  db.exec("INSERT INTO parent VALUES (1)");
  db.close();
  return path;
}

const config = (path: string, readonly = false): DbConnectionConfig => ({ type: "sqlite", path, readonly });
const adapter = () => getAdapter("sqlite");

function read<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite write session", () => {
  it("keeps what a commit ends: the table it created and the rows it wrote", async () => {
    const path = seed();
    const session = await adapter().openWriteSession(config(path));
    await session.ddl("CREATE TABLE t (a TEXT, b TEXT)");
    expect(await session.run({ sql: "INSERT INTO t (a, b) VALUES (?, ?), (?, ?)", params: ["1", null, "2", "x"] })).toBe(2);
    await session.commit();
    expect(read(path, "SELECT a, b FROM t ORDER BY a")).toEqual([{ a: "1", b: null }, { a: "2", b: "x" }]);
  });

  it("takes everything back when it is closed without a commit, the CREATE TABLE included", async () => {
    const path = seed();
    const session = await adapter().openWriteSession(config(path));
    await session.ddl("CREATE TABLE t (a TEXT)");
    await session.run({ sql: "INSERT INTO t (a) VALUES (?)", params: ["1"] });
    await session.ddl("DELETE FROM parent");
    await session.close();
    expect(read(path, "SELECT name FROM sqlite_master WHERE name = 't'")).toEqual([]);
    expect(read(path, "SELECT id FROM parent")).toEqual([{ id: 1 }]);
  });

  it("may be closed twice, and after a commit; nothing runs on it once closed", async () => {
    const path = seed();
    const session = await adapter().openWriteSession(config(path));
    await session.close();
    await session.close();
    await expect(session.run({ sql: "INSERT INTO parent VALUES (?)", params: [2] })).rejects.toThrow("closed");
    const committed = await adapter().openWriteSession(config(path));
    await committed.commit();
    await committed.close();
  });

  it("lets the file go when it ends, so another writer gets it at once", async () => {
    const path = seed();
    const session = await adapter().openWriteSession(config(path));
    await session.close();
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout = 0");
    expect(() => db.exec("INSERT INTO parent VALUES (2)")).not.toThrow();
    db.close();
  });

  it("enforces foreign keys, as the shared handle does", async () => {
    const path = seed();
    const session = await adapter().openWriteSession(config(path));
    await expect(session.run({ sql: "INSERT INTO child (id, parent_id) VALUES (?, ?)", params: [1, 99] })).rejects.toThrow(/FOREIGN KEY/);
    await session.close();
  });

  it("binds as many parameters as SQLite 3.32 and later take", async () => {
    const path = seed();
    const session = await adapter().openWriteSession(config(path));
    expect(session.maxParams).toBe(32_766);
    await session.close();
  });

  it("is refused on a readonly connection, before the file is opened", async () => {
    const path = seed();
    await expect(adapter().openWriteSession(config(path, true))).rejects.toBeInstanceOf(ReadonlyViolationError);
    await expect(adapter().openWriteSession(config(path, true))).rejects.toThrow("importing is disabled");
  });
});
