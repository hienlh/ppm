/**
 * The task store's tables (migration 74). Every statement is `IF NOT EXISTS` / `OR IGNORE`, so the
 * step is safe to run again and to renumber. One statement per `exec`: bun:sqlite raises only the
 * last statement's error from a multi-statement `exec`, which would let the version be bumped over
 * a schema that lacks a table.
 */
import type { Database } from "bun:sqlite";

const TABLES: readonly string[] = [
  // One row per project that ever had the store switched on. `manager_news_*` is how far the
  // project's manager chat has been told about changes (history id, link-state change time).
  `CREATE TABLE IF NOT EXISTS task_projects (
    project_key TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    enabled_changed_at INTEGER,
    enabled_by TEXT CHECK (enabled_by IN ('user','manager_assign','migration')),
    next_number INTEGER NOT NULL DEFAULT 1,
    manager_news_history_id INTEGER NOT NULL DEFAULT 0,
    manager_news_at INTEGER NOT NULL DEFAULT 0,
    check_interval_min INTEGER NOT NULL DEFAULT 30
  )`,
  `CREATE TABLE IF NOT EXISTS task_statuses (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    name TEXT NOT NULL,
    base_group TEXT NOT NULL CHECK (base_group IN ('not_started','active','waiting','closed')),
    closed_as TEXT CHECK (closed_as IN ('done','dropped') OR closed_as IS NULL),
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_key, name COLLATE NOCASE)
  )`,
  // Member `me` ("You") is virtual and never a row.
  `CREATE TABLE IF NOT EXISTS task_members (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    name TEXT NOT NULL,
    jira_account_id TEXT,
    github_login TEXT,
    slack_user_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS task_field_defs (
    project_key TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text','number','select','date','link')),
    options_json TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_key, key)
  )`,
  // `type` has no CHECK: the list of task types may grow; writes are checked in shared code.
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'task',
    status_id TEXT NOT NULL,
    urgency TEXT NOT NULL CHECK (urgency IN ('now','today','week','later')),
    importance TEXT NOT NULL CHECK (importance IN ('must','should','nice')),
    rank REAL NOT NULL DEFAULT 0,
    why TEXT,
    next_step TEXT,
    notes TEXT,
    due_date TEXT,
    tags_json TEXT,
    assignee_member_id TEXT,
    waiting_on_member_id TEXT,
    waiting_since INTEGER,
    parent_id TEXT,
    working_session_id TEXT,
    decision_json TEXT,
    fields_json TEXT,
    result_text TEXT,
    result_at INTEGER,
    result_by TEXT,
    handed_off_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    deleted_at INTEGER,
    UNIQUE (project_key, number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project_open ON tasks(project_key, deleted_at, closed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_working_session ON tasks(working_session_id)`,
  `CREATE TABLE IF NOT EXISTS task_links (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('jira','pr','session','url')),
    ref TEXT NOT NULL,
    label TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    UNIQUE (task_id, kind, ref)
  )`,
  // Cached live state of a link (Jira status, PR state, chat state); written by the link checker.
  `CREATE TABLE IF NOT EXISTS task_link_state (
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    project_key TEXT NOT NULL,
    state_json TEXT,
    error TEXT,
    checked_at INTEGER,
    changed_at INTEGER,
    PRIMARY KEY (kind, ref, project_key)
  )`,
  // The last check of a handed-off task's working session; written by the checker only.
  `CREATE TABLE IF NOT EXISTS task_child_checks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running','waiting_card','stalled','finished_no_report')),
    checked_at INTEGER NOT NULL,
    last_progress_at INTEGER,
    transcript_offset INTEGER,
    recent_forms_json TEXT,
    alerts INTEGER NOT NULL DEFAULT 0,
    last_alert_at INTEGER,
    last_alert_state TEXT
  )`,
  // `task_id` NULL is a project-config event (statuses, members, fields, the switch): never undoable.
  `CREATE TABLE IF NOT EXISTS task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    project_key TEXT NOT NULL,
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_session_id TEXT,
    actor_label TEXT NOT NULL,
    via TEXT NOT NULL,
    unattended INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    changes_json TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    undo_of INTEGER,
    undone_by INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, at)`,
  `CREATE INDEX IF NOT EXISTS idx_task_history_project ON task_history(project_key, id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_history_at ON task_history(at)`,
];

/**
 * Creates the tables, then turns the store on for every project that already has a manager chat
 * (statuses are seeded on first use by the projects service, not here).
 */
export function applyPpmTasksSchema(database: Database, now: number = Date.now()): void {
  for (const sql of TABLES) database.exec(sql);
  const hasManagers = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_chats'").get();
  if (!hasManagers) return;
  database.query(
    `INSERT OR IGNORE INTO task_projects (project_key, project_path, enabled, enabled_changed_at, enabled_by)
     SELECT project_key, project_path, 1, ?, 'migration' FROM manager_chats`,
  ).run(now);
}

/**
 * Snoozing a task (migration 75): the day it shows again, whether a link change brings it back,
 * when the snooze was set (a link change is compared with it) and when PPM last brought the task
 * back; and on the link-state cache, when the part of a link that wakes a snooze last changed (a
 * Jira issue's status; a PR's state or review). Only adds columns; an older PPM reads both tables
 * without them. Safe to run again.
 */
export function applyPpmTasksSnoozeSchema(database: Database): void {
  const hasTasks = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
  if (!hasTasks) return;
  const have = new Set((database.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name));
  const add = (column: string, definition: string) => {
    if (!have.has(column)) database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  };
  add("snoozed_until", "TEXT");
  add("snooze_until_change", "INTEGER NOT NULL DEFAULT 0");
  add("snoozed_at", "INTEGER");
  add("resurfaced_at", "INTEGER");
  const hasLinkState = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_link_state'").get();
  const linkCols = new Set(hasLinkState ? (database.query("PRAGMA table_info(task_link_state)").all() as Array<{ name: string }>).map((c) => c.name) : []);
  if (hasLinkState && !linkCols.has("snooze_changed_at")) database.exec("ALTER TABLE task_link_state ADD COLUMN snooze_changed_at INTEGER");
  // The sweep reads only snoozed tasks; most have none.
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_tasks_snoozed ON tasks(project_key) WHERE snoozed_until IS NOT NULL OR snooze_until_change = 1",
  );
}
