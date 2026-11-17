/**
 * Reading tasks: one task, a filtered list in "what to do first" order, a task's children, and the
 * handed-off tasks the checker should look at. Lists cover only projects with the store switched
 * on; switched off, a project's tasks are hidden, not gone.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import type { BaseGroup, Task, TaskChildCheck, TaskFilter, TaskStatusDef, TaskView } from "../../shared/ppm-tasks.ts";
import { compareTasks } from "../../shared/ppm-tasks-order.ts";
import { effectiveUrgency } from "../../shared/ppm-tasks-urgency.ts";
import { waitingStartedAtFromHistory, type StatusHistoryEntry } from "../../shared/ppm-tasks-waiting.ts";
import { hasSnooze, snoozeWakeReason } from "../../shared/ppm-tasks-snooze.ts";
import { lastLinkChanges, linksFor, loadTask, rowToTask, statusRows, type TaskRow } from "./ppm-tasks-db.ts";
import { todayYmd, userTimeZone, ymdInZone } from "./ppm-tasks-today.ts";
import { isHandedOff } from "./ppm-tasks-write.ts";

const statusesOf = (projectKeys: string[]): Map<string, TaskStatusDef> => {
  const out = new Map<string, TaskStatusDef>();
  for (const key of new Set(projectKeys)) for (const s of statusRows(key)) out.set(s.id, s);
  return out;
};

/**
 * When each listed task's stay in the Waiting group began, from the status moves in its history
 * (kept past compaction, so the answer does not fade after 90 days). One query for the lot.
 */
function waitingStarts(tasks: Task[], statuses: Map<string, TaskStatusDef>): Map<string, number> {
  const out = new Map<string, number>();
  if (tasks.length === 0) return out;
  const taskIds = tasks.map((t) => t.id);
  const rows = getDb().query(
    `SELECT id, task_id, at, changes_json FROM task_history
     WHERE task_id IN (${taskIds.map(() => "?").join(",")}) AND changes_json LIKE '%"statusId"%'`,
  ).all(...taskIds) as Array<{ id: number; task_id: string; at: number; changes_json: string }>;
  const deleted = deletedStatusGroups([...new Set(tasks.map((t) => t.projectKey))]);
  const byTask = new Map<string, StatusHistoryEntry[]>();
  for (const r of rows) {
    let changes: StatusHistoryEntry["changes"];
    try { changes = JSON.parse(r.changes_json); } catch { continue; }
    if (!Array.isArray(changes)) continue;
    const list = byTask.get(r.task_id) ?? [];
    list.push({ id: r.id, at: r.at, changes });
    byTask.set(r.task_id, list);
  }
  const groupOf = (id: string) => statuses.get(id)?.baseGroup ?? deleted.get(id);
  for (const [id, entries] of byTask) {
    const at = waitingStartedAtFromHistory(entries, groupOf);
    if (at !== null) out.set(id, at);
  }
  return out;
}

/** The groups of the projects' deleted statuses, from the config history that recorded each deletion. */
function deletedStatusGroups(projectKeys: string[]): Map<string, BaseGroup> {
  const out = new Map<string, BaseGroup>();
  const rows = getDb().query(
    `SELECT changes_json FROM task_history
     WHERE task_id IS NULL AND project_key IN (${projectKeys.map(() => "?").join(",")}) AND changes_json LIKE '%"status.delete"%'`,
  ).all(...projectKeys) as Array<{ changes_json: string }>;
  for (const r of rows) {
    try {
      for (const c of JSON.parse(r.changes_json) as Array<{ field?: string; before?: { id?: unknown; baseGroup?: unknown } }>) {
        if (c.field === "status.delete" && typeof c.before?.id === "string" && typeof c.before.baseGroup === "string") out.set(c.before.id, c.before.baseGroup as BaseGroup);
      }
    } catch { /* an unreadable row names no status */ }
  }
  return out;
}

/**
 * Decorates tasks with their status group, effective urgency, when their wait began and their
 * snooze state. A snooze whose day came or whose link changed reads as over at once, before the
 * sweep records it.
 */
export function toViews(tasks: Task[], today: string = todayYmd()): TaskView[] {
  const statuses = statusesOf(tasks.map((t) => t.projectKey));
  const waiting = tasks.filter((t) => statuses.get(t.statusId)?.baseGroup === "waiting");
  const starts = waitingStarts(waiting, statuses);
  const linkChanges = lastLinkChanges(tasks.filter((t) => t.snoozeUntilChange));
  const zone = tasks.some((t) => t.resurfacedAt !== null) ? userTimeZone() : undefined;
  return tasks.map((t) => {
    const status = statuses.get(t.statusId);
    const eff = effectiveUrgency(t.urgency, t.dueDate, today);
    const woke = hasSnooze(t) && snoozeWakeReason(t, today, linkChanges.get(t.id)?.at ?? null) !== null;
    const closed = status?.baseGroup === "closed";
    return {
      ...t, baseGroup: status?.baseGroup ?? "not_started", closedAs: status?.closedAs ?? null, effectiveUrgency: eff, urgencyRaised: eff !== t.urgency,
      waitingStartedAt: starts.get(t.id) ?? null,
      snoozed: !closed && hasSnooze(t) && !woke,
      resurfacedToday: !closed && (woke || (t.resurfacedAt !== null && ymdInZone(t.resurfacedAt, zone) === today)),
    };
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
  const snoozed = filter.snoozed ?? "exclude";
  const views = toViews(rows.map((r) => rowToTask(r, links.get(r.id) ?? [])), today)
    .filter((t) => (snoozed === "include" ? true : snoozed === "only" ? t.snoozed : !t.snoozed))
    .sort(compareTasks);
  return filter.limit && filter.limit > 0 ? views.slice(0, filter.limit) : views;
}

/**
 * Open tasks that came back from a snooze on `day` (the user's `YYYY-MM-DD`), from switched-on
 * projects, in "what to do first" order. Only what PPM recorded counts: run the sweep first.
 */
export function listResurfacedOn(day: string): TaskView[] {
  const rows = getDb().query(
    `SELECT t.* FROM tasks t JOIN task_projects p ON p.project_key = t.project_key AND p.enabled = 1
     WHERE t.deleted_at IS NULL AND t.resurfaced_at IS NOT NULL`,
  ).all() as TaskRow[];
  const links = linksFor(rows.map((r) => r.id));
  return toViews(rows.map((r) => rowToTask(r, links.get(r.id) ?? [])), day)
    .filter((t) => t.resurfacedToday && !t.snoozed && t.baseGroup !== "closed")
    .sort(compareTasks);
}

/** How many open tasks of these projects are snoozed right now. */
export function countSnoozed(projectKeys: string[], today?: string): number {
  return projectKeys.length ? listTasks({ projectKeys, snoozed: "only" }, today).length : 0;
}

/** A task's children, in order, closed ones included. */
export function taskChildren(parentId: string, today?: string): TaskView[] {
  const parent = loadTask(parentId);
  if (!parent) return [];
  return listTasks({ projectKeys: [parent.projectKey], parentId, includeClosed: true, snoozed: "include" }, today);
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
 * yet, not snoozed (the user put it out of mind; the check resumes once it is back), in a
 * switched-on project. Each comes with its last check (null when never checked, or
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
  return views.flatMap((task, i) => (!task.snoozed && isHandedOff(task.projectKey, task.workingSessionId)
    ? [{ task, check: childCheckFor(task), intervalMin: rows[i]!.interval_min }] : []));
}
