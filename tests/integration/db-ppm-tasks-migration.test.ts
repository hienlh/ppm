/**
 * Migration 74: PPM Tasks. Only adds tables, and switches the store on for every project that
 * already has a manager chat. A database at 73 is made by running the ladder and dropping what 74
 * added, so the step is tested against the real earlier schema.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../src/services/db.service.ts";
import { applyPpmTasksSchema } from "../../src/services/ppm-tasks/ppm-tasks-schema.ts";

const TASK_TABLES = [
  "task_projects", "task_statuses", "task_members", "task_field_defs", "tasks", "task_links",
  "task_link_state", "task_child_checks", "task_history",
];

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

function fresh(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

function databaseAt73(): Database {
  const db = fresh();
  for (const t of [...TASK_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.exec("PRAGMA user_version = 73");
  return db;
}

describe("migration 74: PPM Tasks", () => {
  it("brings a fresh database to the current version with every task table", () => {
    const db = fresh();
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(74);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    for (const t of TASK_TABLES) expect(tables(db)).toContain(t);
    const cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["result_text", "result_at", "result_by", "handed_off_at", "decision_json", "fields_json"]));
    const projectCols = (db.query("PRAGMA table_info(task_projects)").all() as Array<{ name: string; dflt_value: string | null }>);
    expect(projectCols.find((c) => c.name === "check_interval_min")?.dflt_value).toBe("30");
  });

  it("switches the store on for projects that already have a manager chat", () => {
    const db = databaseAt73();
    db.query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES ('/w/nxsys', '/w/nxsys', 's-1', 'claude', 'user', 1)").run();
    runMigrations(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.query("SELECT project_key, enabled, enabled_by FROM task_projects").all()).toEqual([
      { project_key: "/w/nxsys", enabled: 1, enabled_by: "migration" },
    ]);
  });

  it("is safe to run again, and keeps a project the user switched off", () => {
    const db = fresh();
    db.query("INSERT INTO task_projects (project_key, project_path, enabled, enabled_by) VALUES ('/w/a', '/w/a', 0, 'user')").run();
    db.query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES ('/w/a', '/w/a', 's-2', 'claude', 'user', 1)").run();
    applyPpmTasksSchema(db);
    applyPpmTasksSchema(db);
    expect(db.query("SELECT enabled FROM task_projects WHERE project_key = '/w/a'").get()).toEqual({ enabled: 0 });
  });

  it("refuses rows that break the constraints", () => {
    const db = fresh();
    expect(() => db.query("INSERT INTO task_statuses (id, project_key, name, base_group) VALUES ('x', 'p', 'Bad', 'later')").run()).toThrow();
    db.query("INSERT INTO task_statuses (id, project_key, name, base_group) VALUES ('a', 'p', 'Done', 'closed')").run();
    expect(() => db.query("INSERT INTO task_statuses (id, project_key, name, base_group) VALUES ('b', 'p', 'done', 'closed')").run()).toThrow();
    db.query("INSERT INTO tasks (id, project_key, number, title, status_id, urgency, importance, created_at, updated_at) VALUES ('t', 'p', 1, 'x', 'a', 'now', 'must', 1, 1)").run();
    db.query("INSERT INTO task_child_checks (task_id, session_id, state, checked_at) VALUES ('t', 's', 'stalled', 1)").run();
    expect(() => db.query("UPDATE task_child_checks SET state = 'asleep' WHERE task_id = 't'").run()).toThrow();
    expect(() => db.query("INSERT INTO tasks (id, project_key, number, title, status_id, urgency, importance, created_at, updated_at) VALUES ('u', 'p', 1, 'dup', 'a', 'now', 'must', 1, 1)").run()).toThrow();
  });
});
