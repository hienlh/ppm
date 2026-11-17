/**
 * Migration 75: snoozing a task. Only adds four columns to `tasks` (and a partial index); a task
 * written before it reads as not snoozed. A database at 74 is made by running the ladder and
 * rebuilding `tasks` without the new columns, so the step runs against the real earlier shape.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../src/services/db.service.ts";
import { applyPpmTasksSnoozeSchema } from "../../src/services/ppm-tasks/ppm-tasks-schema.ts";

const SNOOZE_COLUMNS = ["snoozed_until", "snooze_until_change", "snoozed_at", "resurfaced_at"];
const columns = (db: Database) => (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>);
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

function fresh(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

/** The tasks table the way migration 74 left it, with one task in it. */
function databaseAt74(): Database {
  const db = fresh();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP INDEX IF EXISTS idx_tasks_snoozed");
  for (const c of SNOOZE_COLUMNS) db.exec(`ALTER TABLE tasks DROP COLUMN ${c}`);
  db.exec("ALTER TABLE task_link_state DROP COLUMN snooze_changed_at");
  db.exec("PRAGMA foreign_keys = ON");
  db.query("INSERT INTO tasks (id, project_key, number, title, status_id, urgency, importance, created_at, updated_at) VALUES ('t1', 'p', 1, 'old task', 's', 'now', 'must', 1, 1)").run();
  db.exec("PRAGMA user_version = 74");
  return db;
}

describe("migration 75: task snooze", () => {
  it("brings a fresh database to the current version with the snooze columns", () => {
    const db = fresh();
    expect(CURRENT_SCHEMA_VERSION).toBe(75);
    expect(version(db)).toBe(75);
    const cols = columns(db);
    for (const c of SNOOZE_COLUMNS) expect(cols.map((x) => x.name)).toContain(c);
    expect((db.query("PRAGMA table_info(task_link_state)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("snooze_changed_at");
    const flag = cols.find((c) => c.name === "snooze_until_change")!;
    expect(flag.notnull).toBe(1);
    expect(flag.dflt_value).toBe("0");
  });

  it("adds the columns to a database at 74 and keeps its tasks, not snoozed", () => {
    const db = databaseAt74();
    expect(columns(db).map((c) => c.name)).not.toContain("snoozed_until");
    runMigrations(db);
    expect(version(db)).toBe(75);
    expect(db.query("SELECT title, snoozed_until, snooze_until_change, snoozed_at, resurfaced_at FROM tasks WHERE id = 't1'").get()).toEqual({
      title: "old task", snoozed_until: null, snooze_until_change: 0, snoozed_at: null, resurfaced_at: null,
    });
    expect((db.query("PRAGMA table_info(task_link_state)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("snooze_changed_at");
    const index = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_snoozed'").get();
    expect(index).toBeTruthy();
  });

  it("is safe to run again", () => {
    const db = fresh();
    applyPpmTasksSnoozeSchema(db);
    applyPpmTasksSnoozeSchema(db);
    expect(columns(db).filter((c) => c.name === "snoozed_until")).toHaveLength(1);
  });
});
