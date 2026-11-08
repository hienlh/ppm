/**
 * Migration 59: `session_metadata.spawned_by` and `spawn_depth`, which say which session's AI
 * created a session and how deep in such a chain it sits. Every existing session was started by a
 * person, so existing rows read as depth 0 with no creator.
 *
 * A build of the session tools once numbered this migration 58, the number the script-schedule
 * schema took. A database that build opened reads 58 without the schedule tables, so 59 applies
 * that schema again.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

/** Every table at the current version, with `session_metadata` the way version 58 left it. */
function databaseAt58(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  db.exec("DROP INDEX IF EXISTS idx_session_metadata_spawned_by");
  db.exec("ALTER TABLE session_metadata DROP COLUMN spawned_by");
  db.exec("ALTER TABLE session_metadata DROP COLUMN spawn_depth");
  db.exec("PRAGMA user_version = 58");
  return db;
}

type Column = { name: string; notnull: number; dflt_value: string | null };

const tableExists = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;

describe("migration 59: who created a session", () => {
  it("adds both columns, reading every existing session as started by a person", () => {
    const db = databaseAt58();
    db.query("INSERT INTO session_metadata (session_id) VALUES ('old-session-1')").run();

    runMigrations(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(59);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    const columns = db.query("PRAGMA table_info(session_metadata)").all() as Column[];
    expect(columns.find((c) => c.name === "spawned_by")).toMatchObject({ notnull: 0, dflt_value: null });
    expect(columns.find((c) => c.name === "spawn_depth")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: null, spawn_depth: 0 }]);
  });

  it("leaves a database that already has the columns as it is", () => {
    const db = databaseAt58();
    db.exec("ALTER TABLE session_metadata ADD COLUMN spawned_by TEXT");
    db.exec("ALTER TABLE session_metadata ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-1', 'parent-1', 2)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: "parent-1", spawn_depth: 2 }]);
  });

  it("gives a database at 58 without the script-schedule schema the tables and columns it skipped", () => {
    // The shape the session tools' own migration 58 left: spawned_by columns, no schedule schema.
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.exec("DROP TABLE schedule_chats");
    db.exec("DROP TABLE schedule_ai_turns");
    db.exec("DROP TABLE schedule_runtime");
    for (const column of ["kind", "mode", "description", "script", "inputs_json", "input_values_json", "secrets_enc", "state_json"]) {
      db.exec(`ALTER TABLE schedules DROP COLUMN ${column}`);
    }
    db.exec("PRAGMA user_version = 58");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-1', 'parent-1', 1)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 59 });
    for (const table of ["schedule_chats", "schedule_ai_turns", "schedule_runtime"]) expect(tableExists(db, table)).toBe(true);
    const scheduleColumns = (db.query("PRAGMA table_info(schedules)").all() as Column[]).map((c) => c.name);
    expect(scheduleColumns).toEqual(expect.arrayContaining(["kind", "mode", "script", "inputs_json", "state_json"]));
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: "parent-1", spawn_depth: 1 }]);
  });
});
