/**
 * Migration 76: the Schedules window. Adds `task_id` (the task a reminder belongs to) and
 * `attention_dismissed` (the problem the user dismissed) to `schedules`, plus an index on
 * `task_id`. A database at 75 is made by running the ladder and dropping the two columns, so the
 * step runs against the real earlier shape and keeps every schedule it finds.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../src/services/db.service.ts";

const NEW_COLUMNS = ["task_id", "attention_dismissed"];
const columnNames = (db: Database) => (db.query("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).map((c) => c.name);
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const hasIndex = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_schedules_task'").get();

function fresh(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

/** `schedules` the way migration 75 left it, with one session schedule in it. */
function databaseAt75(): Database {
  const db = fresh();
  db.exec("DROP INDEX IF EXISTS idx_schedules_task");
  for (const c of NEW_COLUMNS) db.exec(`ALTER TABLE schedules DROP COLUMN ${c}`);
  db.query(
    `INSERT INTO schedules (name, cron_expr, provider_id, project_path, prompt, kind, target_session_id, timezone, recurring)
     VALUES ('Remind me', '30 18 17 11 *', 'claude', '/p', 'check the PR', 'session', 's1', 'Europe/London', 0)`,
  ).run();
  db.exec("PRAGMA user_version = 75");
  return db;
}

describe("migration 76: schedules linked to tasks", () => {
  it("brings a fresh database to the current version with both columns and the index", () => {
    const db = fresh();
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(76);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    for (const c of NEW_COLUMNS) expect(columnNames(db)).toContain(c);
    expect(hasIndex(db)).toBe(true);
  });

  it("adds the columns to a database at 75 and keeps its schedules, linked to nothing", () => {
    const db = databaseAt75();
    expect(columnNames(db)).not.toContain("task_id");
    runMigrations(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.query("SELECT name, timezone, recurring, task_id, attention_dismissed FROM schedules").get()).toEqual({
      name: "Remind me", timezone: "Europe/London", recurring: 0, task_id: null, attention_dismissed: null,
    });
    expect(hasIndex(db)).toBe(true);
  });

  it("is safe to run again", () => {
    const db = fresh();
    db.exec("PRAGMA user_version = 75");
    runMigrations(db);
    expect(columnNames(db).filter((c) => c === "task_id")).toHaveLength(1);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
