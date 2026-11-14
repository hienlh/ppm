/**
 * Migration 72: session schedules. The kind is a CHECK constraint, which SQLite cannot alter, so
 * `schedules` is rebuilt — and a rebuild done with foreign keys on would empty every table that
 * references a schedule through ON DELETE CASCADE. Each test starts from `schedules` shaped the
 * way version 71 left it and runs the real ladder over it.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

/** Every table at the current version, with `schedules` put back the way migrations 31 and 58 made it. */
function databaseAt71(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE schedules");
  db.exec(`
    CREATE TABLE schedules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      cron_expr       TEXT NOT NULL,
      provider_id     TEXT NOT NULL,
      project_path    TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions',
      max_turns       INTEGER,
      timeout_ms      INTEGER NOT NULL DEFAULT 1800000,
      enabled         INTEGER NOT NULL DEFAULT 1,
      session_id      TEXT,
      last_run_at     TEXT,
      next_fire_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_schedules_enabled_next ON schedules(enabled, next_fire_at);
    ALTER TABLE schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt' CHECK (kind IN ('prompt', 'script'));
    ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'tick' CHECK (mode IN ('tick', 'always-on'));
    ALTER TABLE schedules ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE schedules ADD COLUMN script TEXT;
    ALTER TABLE schedules ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE schedules ADD COLUMN input_values_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE schedules ADD COLUMN secrets_enc TEXT;
    ALTER TABLE schedules ADD COLUMN state_json TEXT;
  `);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA user_version = 71");
  return db;
}

function addSchedule(db: Database, kind: string, name: string): number {
  db.query("INSERT INTO schedules (name, cron_expr, provider_id, project_path, prompt, kind) VALUES (?, '0 9 * * *', 'claude-agent-sdk', '/p', 'go', ?)").run(name, kind);
  return (db.query("SELECT id FROM schedules WHERE name = ?").get(name) as { id: number }).id;
}

const count = (db: Database, table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("migration 72: session schedules", () => {
  it("admits kind session, still refuses an unknown kind, and adds the columns and index", () => {
    const db = databaseAt71();
    expect(() => addSchedule(db, "session", "early")).toThrow("CHECK constraint failed");

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
    addSchedule(db, "session", "later");
    expect(() => addSchedule(db, "bogus", "never")).toThrow("CHECK constraint failed");
    // The mode CHECK beside it is untouched.
    expect(() => db.query("UPDATE schedules SET mode = 'sometimes'").run()).toThrow("CHECK constraint failed");

    const columns = (db.query("PRAGMA table_info(schedules)").all() as { name: string; dflt_value: string | null }[]);
    for (const c of ["target_session_id", "timezone", "recurring", "pending_since", "paused_reason"]) {
      expect(columns.map((x) => x.name)).toContain(c);
    }
    expect(columns.find((c) => c.name === "recurring")!.dflt_value).toBe("1");
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'schedules'").all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain("idx_schedules_target_session");
    expect(indexes).toContain("idx_schedules_enabled_next");
  });

  it("keeps every schedule and every row that references one, ids and counter included", () => {
    const db = databaseAt71();
    const kept = addSchedule(db, "prompt", "kept");
    const script = addSchedule(db, "script", "script");
    const gone = addSchedule(db, "prompt", "gone");
    db.query("DELETE FROM schedules WHERE id = ?").run(gone);
    db.query("INSERT INTO schedule_runs (schedule_id, status) VALUES (?, 'done')").run(kept);
    db.query("INSERT INTO schedule_chats (schedule_id, key, session_id) VALUES (?, 'k', 's')").run(script);
    db.query("INSERT INTO schedule_ai_turns (schedule_id, key, session_id, status) VALUES (?, 'k', 's', 'done')").run(script);
    db.query("INSERT INTO schedule_runtime (schedule_id, pid) VALUES (?, 42)").run(script);

    runMigrations(db);

    expect(db.query("SELECT id, name, kind, recurring, timezone FROM schedules ORDER BY id").all()).toEqual([
      { id: kept, name: "kept", kind: "prompt", recurring: 1, timezone: null },
      { id: script, name: "script", kind: "script", recurring: 1, timezone: null },
    ]);
    for (const table of ["schedule_runs", "schedule_chats", "schedule_ai_turns", "schedule_runtime"]) expect(count(db, table)).toBe(1);
    // An id a deleted schedule had is never handed out again.
    expect(addSchedule(db, "session", "new")).toBe(gone + 1);
    // The references still cascade from the rebuilt table.
    db.query("DELETE FROM schedules WHERE id = ?").run(script);
    expect(count(db, "schedule_runtime")).toBe(0);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("is a no-op on a database already at the current version", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'schedules'").get() as { sql: string }).sql;
    expect(sql).toContain("'session'");
    db.exec("PRAGMA user_version = 71");
    runMigrations(db);
    expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'schedules'").get() as { sql: string }).sql).toBe(sql);
  });

  it("refuses to rebuild inside a caller's transaction, where the drop would cascade", () => {
    const db = databaseAt71();
    db.exec("BEGIN");
    expect(() => runMigrations(db)).toThrow("Cannot rebuild the schedules table inside a transaction");
    db.exec("ROLLBACK");
  });
});
