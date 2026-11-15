/**
 * The per-project switch and settings. Off by default; switched on automatically when a project
 * gets a manager chat (and by migration 74 for projects that already had one). Switching off hides
 * the project's tasks everywhere and deletes nothing.
 */
import { getDb } from "../db.service.ts";
import { projectKey as keyOf } from "../project-name-for-path.ts";
import {
  CHECK_INTERVAL_MAX_MIN, CHECK_INTERVAL_MIN_MIN, type BaseGroup, type ClosedAs, type WriteContext,
} from "../../shared/ppm-tasks.ts";
import { invalid, notFound } from "./ppm-tasks-errors.ts";
import { writeHistory } from "./ppm-tasks-history.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";

export interface TaskProject {
  projectKey: string;
  projectPath: string;
  enabled: boolean;
  enabledChangedAt: number | null;
  enabledBy: "user" | "manager_assign" | "migration" | null;
  checkIntervalMin: number;
}

interface ProjectRow {
  project_key: string; project_path: string; enabled: number; enabled_changed_at: number | null;
  enabled_by: TaskProject["enabledBy"]; check_interval_min: number;
}

const toProject = (r: ProjectRow): TaskProject => ({
  projectKey: r.project_key, projectPath: r.project_path, enabled: r.enabled === 1, enabledChangedAt: r.enabled_changed_at,
  enabledBy: r.enabled_by, checkIntervalMin: r.check_interval_min,
});

export const DEFAULT_STATUSES: ReadonlyArray<{ name: string; baseGroup: BaseGroup; closedAs: ClosedAs | null }> = [
  { name: "To do", baseGroup: "not_started", closedAs: null },
  { name: "In progress", baseGroup: "active", closedAs: null },
  { name: "Waiting", baseGroup: "waiting", closedAs: null },
  { name: "Done", baseGroup: "closed", closedAs: "done" },
  { name: "Dropped", baseGroup: "closed", closedAs: "dropped" },
];

export function getTaskProject(projectKey: string): TaskProject | null {
  const row = getDb().query("SELECT * FROM task_projects WHERE project_key = ?").get(projectKey) as ProjectRow | null;
  return row ? toProject(row) : null;
}

export function listTaskProjects(opts: { enabledOnly?: boolean } = {}): TaskProject[] {
  const sql = `SELECT * FROM task_projects${opts.enabledOnly ? " WHERE enabled = 1" : ""} ORDER BY project_path`;
  return (getDb().query(sql).all() as ProjectRow[]).map(toProject);
}

export const isTasksEnabled = (projectKey: string): boolean => getTaskProject(projectKey)?.enabled ?? false;

/** Seeds the default statuses when the project has none. Call inside a transaction. */
export function seedStatuses(projectKey: string): void {
  const db = getDb();
  const has = db.query("SELECT 1 FROM task_statuses WHERE project_key = ? LIMIT 1").get(projectKey);
  if (has) return;
  const insert = db.query("INSERT INTO task_statuses (id, project_key, name, base_group, closed_as, position) VALUES (?, ?, ?, ?, ?, ?)");
  DEFAULT_STATUSES.forEach((s, i) => insert.run(crypto.randomUUID(), projectKey, s.name, s.baseGroup, s.closedAs, i));
}

function upsertProjectRow(projectKey: string, projectPath: string): void {
  getDb().query("INSERT OR IGNORE INTO task_projects (project_key, project_path) VALUES (?, ?)").run(projectKey, projectPath);
}

/** Turns the store on or off for a project folder. Returns the project as it now stands. */
export function setTasksEnabled(projectPath: string, enabled: boolean, ctx: WriteContext, now: number = Date.now()): TaskProject {
  const key = keyOf(projectPath);
  const db = getDb();
  let changed = false;
  db.transaction(() => {
    upsertProjectRow(key, projectPath);
    const before = getTaskProject(key)!;
    if (enabled) seedStatuses(key);
    if (before.enabled === enabled) return;
    db.query("UPDATE task_projects SET enabled = ?, enabled_changed_at = ?, enabled_by = 'user', project_path = ? WHERE project_key = ?")
      .run(enabled ? 1 : 0, now, projectPath, key);
    writeHistory({ taskId: null, projectKey: key, ctx, kind: "project", changes: [{ field: "enabled", before: before.enabled, after: enabled }], at: now });
    changed = true;
  })();
  if (changed) ppmTasksEvents.emit({ type: "project", projectKey: key, what: "switch", actor: ctx.actor, via: ctx.via });
  return getTaskProject(key)!;
}

/**
 * A project got a manager chat: the store is switched on if it was off, and the manager's news
 * starts from now, so a new manager is not handed the project's whole past as news.
 */
export function enableOnManagerAssigned(projectKey: string, projectPath: string, now: number = Date.now()): void {
  const db = getDb();
  let switched = false;
  db.transaction(() => {
    upsertProjectRow(projectKey, projectPath);
    seedStatuses(projectKey);
    const before = getTaskProject(projectKey)!;
    const lastHistory = (db.query("SELECT COALESCE(MAX(id), 0) AS id FROM task_history").get() as { id: number }).id;
    db.query("UPDATE task_projects SET manager_news_history_id = ?, manager_news_at = ? WHERE project_key = ?").run(lastHistory, now, projectKey);
    if (before.enabled) return;
    db.query("UPDATE task_projects SET enabled = 1, enabled_changed_at = ?, enabled_by = 'manager_assign' WHERE project_key = ?").run(now, projectKey);
    switched = true;
  })();
  if (switched) {
    ppmTasksEvents.emit({ type: "project", projectKey, what: "switch", actor: { kind: "ppm", label: "PPM" }, via: "ppm" });
  }
}

/** How often handed-off tasks of this project are checked, in minutes. */
export function setCheckInterval(projectKey: string, minutes: number, ctx: WriteContext, now: number = Date.now()): TaskProject {
  if (!Number.isInteger(minutes) || minutes < CHECK_INTERVAL_MIN_MIN || minutes > CHECK_INTERVAL_MAX_MIN) {
    throw invalid(`The check interval must be a whole number of minutes from ${CHECK_INTERVAL_MIN_MIN} to ${CHECK_INTERVAL_MAX_MIN}`);
  }
  const db = getDb();
  let changed = false;
  db.transaction(() => {
    const before = getTaskProject(projectKey);
    if (!before) throw notFound("Project");
    if (before.checkIntervalMin === minutes) return;
    db.query("UPDATE task_projects SET check_interval_min = ? WHERE project_key = ?").run(minutes, projectKey);
    writeHistory({ taskId: null, projectKey, ctx, kind: "project", changes: [{ field: "checkIntervalMin", before: before.checkIntervalMin, after: minutes }], at: now });
    changed = true;
  })();
  if (changed) ppmTasksEvents.emit({ type: "project", projectKey, what: "settings", actor: ctx.actor, via: ctx.via });
  return getTaskProject(projectKey)!;
}
