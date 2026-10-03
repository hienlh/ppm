/**
 * Migration 55: `connections.type` admits MySQL and MariaDB.
 *
 * SQLite cannot alter a CHECK, so the table is rebuilt — and a rebuild done
 * the ordinary way, with foreign keys on, empties `connection_table_cache`
 * through its ON DELETE CASCADE. Each test starts from a database shaped the
 * way version 54 left it and runs the real ladder over it.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

/** Every table at the current version, with `connections` put back the way migrations 2 and 3 created it. */
function databaseAt54(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE connections");
  db.exec(`
    CREATE TABLE connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('sqlite', 'postgres')),
      name TEXT NOT NULL UNIQUE,
      connection_config TEXT NOT NULL,
      group_name TEXT,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_connections_type ON connections(type);
    CREATE INDEX idx_connections_group ON connections(group_name);
    ALTER TABLE connections ADD COLUMN readonly INTEGER NOT NULL DEFAULT 1;
  `);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA user_version = 54");
  return db;
}

function addConnection(db: Database, type: string, name: string): number {
  db.query("INSERT INTO connections (type, name, connection_config, readonly) VALUES (?, ?, ?, 0)").run(type, name, `{"type":"${type}"}`);
  return (db.query("SELECT id FROM connections WHERE name = ?").get(name) as { id: number }).id;
}

function cacheTable(db: Database, connectionId: number, table: string): void {
  db.query("INSERT INTO connection_table_cache (connection_id, table_name, schema_name, row_count) VALUES (?, ?, 'public', 7)").run(connectionId, table);
}

const all = (db: Database, sql: string) => db.query(sql).all();

describe("migration 55: MySQL and MariaDB connections", () => {
  it("admits mysql and mariadb, and still refuses a type nobody speaks", () => {
    const db = databaseAt54();
    expect(() => addConnection(db, "mysql", "early")).toThrow("CHECK constraint failed");

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(55);
    addConnection(db, "mysql", "m");
    addConnection(db, "mariadb", "mdb");
    expect(() => addConnection(db, "oracle", "o")).toThrow("CHECK constraint failed");
  });

  it("keeps every connection and every cached table", () => {
    const db = databaseAt54();
    const pg = addConnection(db, "postgres", "pg");
    const lite = addConnection(db, "sqlite", "lite");
    cacheTable(db, pg, "users");
    cacheTable(db, pg, "orders");
    cacheTable(db, lite, "notes");
    const connections = all(db, "SELECT * FROM connections ORDER BY id");
    const cache = all(db, "SELECT * FROM connection_table_cache ORDER BY id");

    runMigrations(db);

    // Every column the table had, as it was; later migrations may add columns of their own.
    const columns = Object.keys(connections[0] as object);
    const kept = all(db, "SELECT * FROM connections ORDER BY id")
      .map((row) => Object.fromEntries(columns.map((c) => [c, (row as Record<string, unknown>)[c]])));
    expect(kept).toEqual(connections);
    expect(all(db, "SELECT * FROM connection_table_cache ORDER BY id")).toEqual(cache);
  });

  it("leaves the cache still tied to its connection, with foreign keys back on", () => {
    const db = databaseAt54();
    const pg = addConnection(db, "postgres", "pg");
    const lite = addConnection(db, "sqlite", "lite");
    cacheTable(db, pg, "users");
    cacheTable(db, lite, "notes");

    runMigrations(db);

    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.query("DELETE FROM connections WHERE id = ?").run(pg);
    expect(all(db, "SELECT table_name FROM connection_table_cache")).toEqual([{ table_name: "notes" }]);
    expect(all(db, "PRAGMA index_list(connections)").map((i) => (i as { name: string }).name)).toEqual(
      expect.arrayContaining(["idx_connections_type", "idx_connections_group"]),
    );
  });

  it("never hands out the id of a connection that was deleted", () => {
    const db = databaseAt54();
    addConnection(db, "postgres", "a");
    addConnection(db, "postgres", "b");
    const last = addConnection(db, "postgres", "c");
    db.query("DELETE FROM connections WHERE id = ?").run(last);

    runMigrations(db);

    expect(addConnection(db, "mysql", "d")).toBe(last + 1);
  });

  it("keeps the high-water mark even when every connection was deleted", () => {
    const db = databaseAt54();
    const only = addConnection(db, "postgres", "a");
    db.query("DELETE FROM connections").run();

    runMigrations(db);

    expect(addConnection(db, "mysql", "b")).toBe(only + 1);
  });

  it("carries over a column it was not written for", () => {
    const db = databaseAt54();
    db.exec("ALTER TABLE connections ADD COLUMN note TEXT");
    const id = addConnection(db, "postgres", "pg");
    db.query("UPDATE connections SET note = 'kept' WHERE id = ?").run(id);

    runMigrations(db);

    expect(db.query("SELECT note FROM connections WHERE id = ?").get(id)).toEqual({ note: "kept" });
  });

  it("refuses to rebuild inside a caller's transaction, where the drop would cascade", () => {
    const db = databaseAt54();
    cacheTable(db, addConnection(db, "postgres", "pg"), "users");
    db.exec("BEGIN");
    expect(() => runMigrations(db)).toThrow("Cannot rebuild the connections table inside a transaction");
    db.exec("ROLLBACK");
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});
