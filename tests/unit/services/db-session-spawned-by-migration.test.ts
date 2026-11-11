/**
 * Migration 60: `session_metadata.spawned_by` and `spawn_depth`, which say which session's AI
 * created a session and how deep in such a chain it sits. Every existing session was started by a
 * person, so existing rows read as depth 0 with no creator.
 *
 * Builds of the session tools numbered this migration 58 and then 59, numbers main gave to the
 * script-schedule schema (58) and the `session_logs` drop (59). A database such a build opened
 * reads 58 or 59 having skipped main's step at that number, so 60 applies both again.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

/** Every table at the current version, with `session_metadata` the way `version` left it. */
function databaseBeforeSpawnedBy(version: number): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  db.exec("DROP INDEX IF EXISTS idx_session_metadata_spawned_by");
  db.exec("ALTER TABLE session_metadata DROP COLUMN spawned_by");
  db.exec("ALTER TABLE session_metadata DROP COLUMN spawn_depth");
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

/** A current database with the script-schedule schema removed, as a build that skipped it left it. */
function withoutScheduleSchema(db: Database): Database {
  db.exec("DROP TABLE schedule_chats");
  db.exec("DROP TABLE schedule_ai_turns");
  db.exec("DROP TABLE schedule_runtime");
  for (const column of ["kind", "mode", "description", "script", "inputs_json", "input_values_json", "secrets_enc", "state_json"]) {
    db.exec(`ALTER TABLE schedules DROP COLUMN ${column}`);
  }
  return db;
}

/** The table and indexes main's migration 59 drops, as every install before it had them. */
function withSessionLogs(db: Database): Database {
  db.exec(`
    CREATE TABLE session_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_session_logs_session ON session_logs(session_id);
    CREATE INDEX idx_session_logs_created ON session_logs(created_at);
  `);
  db.query("INSERT INTO session_logs (session_id, level, message) VALUES ('s1', 'TEXT', 'a line')").run();
  return db;
}

type Column = { name: string; notnull: number; dflt_value: string | null };

const tableExists = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;

function expectScheduleSchema(db: Database): void {
  for (const table of ["schedule_chats", "schedule_ai_turns", "schedule_runtime"]) expect(tableExists(db, table)).toBe(true);
  const scheduleColumns = (db.query("PRAGMA table_info(schedules)").all() as Column[]).map((c) => c.name);
  expect(scheduleColumns).toEqual(expect.arrayContaining(["kind", "mode", "script", "inputs_json", "state_json"]));
}

describe("migration 60: who created a session", () => {
  it("adds both columns, reading every existing session as started by a person", () => {
    const db = databaseBeforeSpawnedBy(59);
    db.query("INSERT INTO session_metadata (session_id) VALUES ('old-session-1')").run();

    runMigrations(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(61);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    const columns = db.query("PRAGMA table_info(session_metadata)").all() as Column[];
    expect(columns.find((c) => c.name === "spawned_by")).toMatchObject({ notnull: 0, dflt_value: null });
    expect(columns.find((c) => c.name === "spawn_depth")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: null, spawn_depth: 0 }]);
  });

  it("leaves a database that already has the columns as it is", () => {
    const db = databaseBeforeSpawnedBy(59);
    db.exec("ALTER TABLE session_metadata ADD COLUMN spawned_by TEXT");
    db.exec("ALTER TABLE session_metadata ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-1', 'parent-1', 2)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: "parent-1", spawn_depth: 2 }]);
  });

  it("gives a database at the session tools' old 58 the schedule schema and the session_logs drop it skipped", () => {
    // spawned_by present, no schedule schema, session_logs still there, read as 58.
    const db = withSessionLogs(withoutScheduleSchema(openCurrent()));
    db.exec("PRAGMA user_version = 58");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-1', 'parent-1', 1)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    expectScheduleSchema(db);
    expect(tableExists(db, "session_logs")).toBe(false);
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: "parent-1", spawn_depth: 1 }]);
  });

  it("gives a database at the session tools' old 59 the session_logs drop it skipped, keeping its schedules", () => {
    // spawned_by and the schedule schema present, session_logs still there, read as 59.
    const db = withSessionLogs(openCurrent());
    db.exec("PRAGMA user_version = 59");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-2', 'parent-2', 2)").run();

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    expectScheduleSchema(db);
    expect(tableExists(db, "session_logs")).toBe(false);
    expect((db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_session_logs%'").all())).toEqual([]);
    expect(db.query("SELECT spawned_by, spawn_depth FROM session_metadata").all()).toEqual([{ spawned_by: "parent-2", spawn_depth: 2 }]);
  });
});

/** A database migrated to the current version. */
function openCurrent(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}
