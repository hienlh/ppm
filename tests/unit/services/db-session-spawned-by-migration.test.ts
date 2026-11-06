/**
 * Migration 58: `session_metadata.spawned_by` and `spawn_depth`, which say which session's AI
 * created a session and how deep in such a chain it sits. Every existing session was started by a
 * person, so existing rows read as depth 0 with no creator.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

/** Every table at the current version, with `session_metadata` the way version 57 left it. */
function databaseAt57(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  db.exec("DROP INDEX IF EXISTS idx_session_metadata_spawned_by");
  db.exec("ALTER TABLE session_metadata DROP COLUMN spawned_by");
  db.exec("ALTER TABLE session_metadata DROP COLUMN spawn_depth");
  db.exec("PRAGMA user_version = 57");
  return db;
}

type Column = { name: string; notnull: number; dflt_value: string | null };

describe("migration 58: who created a session", () => {
  it("adds both columns, reading every existing session as started by a person", () => {
    const db = databaseAt57();
    db.query("INSERT INTO session_metadata (session_id) VALUES ('old-session-1')").run();

    runMigrations(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(58);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    const columns = db.query("PRAGMA table_info(session_metadata)").all() as Column[];
    expect(columns.find((c) => c.name === "spawned_by")).toMatchObject({ notnull: 0, dflt_value: null });
    expect(columns.find((c) => c.name === "spawn_depth")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: null, spawn_depth: 0 }]);
  });

  it("leaves a database that already has the columns as it is", () => {
    const db = databaseAt57();
    db.exec("ALTER TABLE session_metadata ADD COLUMN spawned_by TEXT");
    db.exec("ALTER TABLE session_metadata ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-1', 'parent-1', 2)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: "parent-1", spawn_depth: 2 }]);
  });
});
