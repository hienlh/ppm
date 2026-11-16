/**
 * Reading tasks: one task, a filtered list in "what to do first" order, a task's children, and the
 * handed-off tasks the checker should look at. Lists cover only projects with the store switched
 * on; switched off, a project's tasks are hidden, not gone.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import type { BaseGroup, Task, TaskChildCheck, TaskFilter, TaskStatusDef, TaskView } from "../../shared/ppm-tasks.ts";
import { compareTasks } from "../../shared/ppm-tasks-order.ts";
import { effectiveUrgency } from "../../shared/ppm-tasks-urgency.ts";
import { linksFor, loadTask, rowToTask, statusRows, type TaskRow } from "./ppm-tasks-db.ts";
import { todayYmd } from "./ppm-tasks-today.ts";
import { isHandedOff } from "./ppm-tasks-write.ts";

const statusesOf = (projectKeys: string[]): Map<string, TaskStatusDef> => {
  const out = new Map<string, TaskStatusDef>();
  for (const key of new Set(projectKeys)) for (const s of statusRows(key)) out.set(s.id, s);
  return out;
};

/** Decorates tasks with their status group and effective urgency. */
export function toViews(tasks: Task[], today: string = todayYmd()): TaskView[] {
  const statuses = statusesOf(tasks.map((t) => t.projectKey));
  return tasks.map((t) => {
    const status = statuses.get(t.statusId);
    const eff = effectiveUrgency(t.urgency, t.dueDate, today);
    return { ...t, baseGroup: status?.baseGroup ?? "not_started", closedAs: status?.closedAs ?? null, effectiveUrgency: eff, urgencyRaised: eff !== t.urgency };
  });
}

/** One task, deleted ones included; null when there is none. */
export function getTask(id: string, today?: string): TaskView | null {
  const task = loadTask(id);
  return task ? toViews([task], today)[0]! : null;
}

/** Tasks matching the filter, in "what to do first" order, from switched-on projects only. */
export function listTasks(filter: TaskFilter = {}, today?: string): TaskView[] {
  const where = ["t.deleted_at IS NULL", "p.enabled = 1"];
  const args: Array<string | number> = [];
  const inList = (column: string, values: readonly string[]) => {
    where.push(`${column} IN (${values.map(() => "?").join(",")})`);
    args.push(...values);
  };
  if (filter.projectKeys) {
    if (filter.projectKeys.length === 0) return [];
    inList("t.project_key", filter.projectKeys);
  }
  if (filter.types?.length) inList("t.type", filter.types);
  if (filter.statusIds?.length) inList("t.status_id", filter.statusIds);
  if (filter.baseGroups?.length) inList("s.base_group", filter.baseGroups);
  const asksClosed = filter.includeClosed || filter.baseGroups?.includes("closed") || !!filter.statusIds?.length;
  if (!asksClosed) where.push("(s.base_group IS NULL OR s.base_group <> 'closed')");
  if (filter.memberId) {
    where.push("(t.assignee_member_id = ? OR t.waiting_on_member_id = ?)");
    args.push(filter.memberId, filter.memberId);
  }
  if (filter.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(COALESCE(t.tags_json, '[]')) WHERE value = ?)");
    args.push(filter.tag);
  }
  if (filter.parentId !== undefined) {
    if (filter.parentId === null) where.push("t.parent_id IS NULL");
    else { where.push("t.parent_id = ?"); args.push(filter.parentId); }
  }
  if (filter.text?.trim()) {
    const like = `%${filter.text.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(LOWER(t.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.why,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.next_step,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.notes,'')) LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const rows = getDb().query(
    `SELECT t.* FROM tasks t JOIN task_projects p ON p.project_key = t.project_key
     LEFT JOIN task_statuses s ON s.id = t.status_id WHERE ${where.join(" AND ")}`,
  ).all(...args) as TaskRow[];
  const links = linksFor(rows.map((r) => r.id));
  const views = toViews(rows.map((r) => rowToTask(r, links.get(r.id) ?? [])), today).sort(compareTasks);
  return filter.limit && filter.limit > 0 ? views.slice(0, filter.limit) : views;
}

/** A task's children, in order, closed ones included. */
export function taskChildren(parentId: string, today?: string): TaskView[] {
  const parent = loadTask(parentId);
  if (!parent) return [];
  return listTasks({ projectKeys: [parent.projectKey], parentId, includeClosed: true }, today);
}

interface CheckRow {
  task_id: string; session_id: string; state: TaskChildCheck["state"]; checked_at: number; last_progress_at: number | null;
  alerts: number; last_alert_at: number | null; last_alert_state: TaskChildCheck["state"] | null;
}
const toCheck = (r: CheckRow): TaskChildCheck => ({
  taskId: r.task_id, sessionId: resolveMigratedSession(r.session_id), state: r.state, checkedAt: r.checked_at,
  lastProgressAt: r.last_progress_at, alerts: r.alerts, lastAlertAt: r.last_alert_at, lastAlertState: r.last_alert_state,
});

/** The last check of a task's working session, when it was a check of that same session. */
export function childCheckFor(task: Pick<Task, "id" | "workingSessionId">): TaskChildCheck | null {
  if (!task.workingSessionId) return null;
  const row = getDb().query("SELECT * FROM task_child_checks WHERE task_id = ?").get(task.id) as CheckRow | null;
  if (!row) return null;
  const check = toCheck(row);
  return check.sessionId === task.workingSessionId ? check : null;
}

/**
 * Tasks that need checking: open, handed off to a chat that is not the manager, with no result
 * yet, in a switched-on project. Each comes with its last check (null when never checked, or
 * checked while handed to another chat) and the project's check interval.
 */
export function listTasksNeedingCheck(projectKey?: string, today?: string): Array<{ task: TaskView; check: TaskChildCheck | null; intervalMin: number }> {
  const closed: BaseGroup = "closed";
  const rows = getDb().query(
    `SELECT t.*, p.check_interval_min AS interval_min FROM tasks t
     JOIN task_projects p ON p.project_key = t.project_key AND p.enabled = 1
     LEFT JOIN task_statuses s ON s.id = t.status_id
     WHERE t.deleted_at IS NULL AND t.handed_off_at IS NOT NULL AND t.working_session_id IS NOT NULL
       AND t.result_text IS NULL AND (s.base_group IS NULL OR s.base_group <> ?)${projectKey ? " AND t.project_key = ?" : ""}
     ORDER BY t.handed_off_at`,
  ).all(...(projectKey ? [closed, projectKey] : [closed])) as Array<TaskRow & { interval_min: number }>;
  const links = linksFor(rows.map((r) => r.id));
  const views = toViews(rows.map((r) => rowToTask(r, links.get(r.id) ?? [])), today);
  // Asked again: the chat may have become the project's manager since it was handed the task.
  return views.flatMap((task, i) => (isHandedOff(task.projectKey, task.workingSessionId)
    ? [{ task, check: childCheckFor(task), intervalMin: rows[i]!.interval_min }] : []));
}
