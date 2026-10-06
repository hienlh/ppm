/**
 * Migration 56: `connections.ai_access`, the connection form's "Available to the AI chat".
 * Every connection saved before it was available to the AI chat, so existing rows keep that.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

/** Every table at the current version, with `connections` the way version 55 left it. */
function databaseAt55(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  db.exec("ALTER TABLE connections DROP COLUMN ai_access");
  db.exec("PRAGMA user_version = 55");
  return db;
}

type Column = { name: string; notnull: number; dflt_value: string | null };

describe("migration 56: Available to the AI chat", () => {
  it("adds the column, on for every connection already saved", () => {
    const db = databaseAt55();
    db.query("INSERT INTO connections (type, name, connection_config) VALUES ('sqlite', 'old', '{}')").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(56);
    const column = (db.query("PRAGMA table_info(connections)").all() as Column[]).find((c) => c.name === "ai_access");
    expect(column).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(db.query("SELECT name, ai_access FROM connections").all()).toEqual([{ name: "old", ai_access: 1 }]);
  });

  it("leaves a database that has the column already as it is", () => {
    const db = databaseAt55();
    db.exec("ALTER TABLE connections ADD COLUMN ai_access INTEGER NOT NULL DEFAULT 1");
    db.query("INSERT INTO connections (type, name, connection_config, ai_access) VALUES ('sqlite', 'hidden', '{}', 0)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT name, ai_access FROM connections").all()).toEqual([{ name: "hidden", ai_access: 0 }]);
  });
});
