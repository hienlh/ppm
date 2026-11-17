/**
 * Row ↔ DTO mapping for the task store, and the reads every other module shares. The JSON columns
 * (tags, fields, decision, history changes) are validated on write and tolerated on read: a value
 * of the wrong shape reads as empty rather than throwing out of a list.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import type {
  FieldDef, FieldType, FieldValue, HistoryEntry, LinkKind, LinkState, Task, TaskDecision, TaskLink,
  TaskMember, TaskStatusDef,
} from "../../shared/ppm-tasks.ts";

export interface TaskRow {
  id: string; project_key: string; number: number; title: string; type: string; status_id: string;
  urgency: Task["urgency"]; importance: Task["importance"]; rank: number;
  why: string | null; next_step: string | null; notes: string | null; due_date: string | null;
  tags_json: string | null; assignee_member_id: string | null; waiting_on_member_id: string | null;
  waiting_since: number | null; parent_id: string | null; working_session_id: string | null;
  decision_json: string | null; fields_json: string | null;
  result_text: string | null; result_at: number | null; result_by: string | null; handed_off_at: number | null;
  /** Absent on a database a test built before migration 75. */
  snoozed_until?: string | null; snooze_until_change?: number | null; snoozed_at?: number | null; resurfaced_at?: number | null;
  revision: number; created_at: number; updated_at: number; closed_at: number | null; deleted_at: number | null;
}

function parseJson<T>(raw: string | null, ok: (v: unknown) => v is T, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isFieldMap = (v: unknown): v is Record<string, FieldValue> =>
  !!v && typeof v === "object" && !Array.isArray(v)
  && Object.values(v).every((x) => x === null || typeof x === "string" || typeof x === "number");
const isDecision = (v: unknown): v is TaskDecision =>
  !!v && typeof v === "object" && Array.isArray((v as TaskDecision).options);

export function rowToTask(r: TaskRow, links: TaskLink[]): Task {
  const decision = parseJson<TaskDecision | null>(r.decision_json, isDecision as (v: unknown) => v is TaskDecision | null, null);
  return {
    id: r.id, projectKey: r.project_key, number: r.number, title: r.title, type: r.type, statusId: r.status_id,
    urgency: r.urgency, importance: r.importance, rank: r.rank,
    why: r.why, nextStep: r.next_step, notes: r.notes, dueDate: r.due_date,
    tags: parseJson(r.tags_json, isStringArray, []),
    assigneeMemberId: r.assignee_member_id, waitingOnMemberId: r.waiting_on_member_id, waitingSince: r.waiting_since,
    parentId: r.parent_id,
    workingSessionId: r.working_session_id ? resolveMigratedSession(r.working_session_id) : null,
    decision: decision ? { question: decision.question ?? null, options: decision.options, chosen: decision.chosen ?? null } : null,
    fields: parseJson(r.fields_json, isFieldMap, {}),
    links,
    result: r.result_text !== null ? { text: r.result_text, at: r.result_at ?? r.updated_at, by: r.result_by ?? "" } : null,
    handedOffAt: r.handed_off_at,
    snoozedUntil: r.snoozed_until ?? null, snoozeUntilChange: r.snooze_until_change === 1,
    snoozedAt: r.snoozed_at ?? null, resurfacedAt: r.resurfaced_at ?? null,
    revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at, deletedAt: r.deleted_at,
  };
}

interface LinkRow { task_id: string; kind: LinkKind; ref: string; label: string | null }

/** Links of these tasks, in their stored order. */
export function linksFor(taskIds: string[]): Map<string, TaskLink[]> {
  const out = new Map<string, TaskLink[]>();
  if (taskIds.length === 0) return out;
  const db = getDb();
  // Chunked: SQLite caps bound parameters.
  for (let i = 0; i < taskIds.length; i += 500) {
    const chunk = taskIds.slice(i, i + 500);
    const rows = db.query(
      `SELECT task_id, kind, ref, label FROM task_links WHERE task_id IN (${chunk.map(() => "?").join(",")}) ORDER BY position, added_at`,
    ).all(...chunk) as LinkRow[];
    for (const row of rows) {
      const list = out.get(row.task_id) ?? [];
      list.push({ kind: row.kind, ref: row.ref, label: row.label });
      out.set(row.task_id, list);
    }
  }
  return out;
}

export function loadTaskRow(id: string): TaskRow | null {
  return (getDb().query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null) ?? null;
}

export function loadTask(id: string): Task | null {
  const row = loadTaskRow(id);
  return row ? rowToTask(row, linksFor([row.id]).get(row.id) ?? []) : null;
}

interface StatusRow { id: string; project_key: string; name: string; base_group: TaskStatusDef["baseGroup"]; closed_as: TaskStatusDef["closedAs"]; position: number }
export const rowToStatus = (r: StatusRow): TaskStatusDef =>
  ({ id: r.id, projectKey: r.project_key, name: r.name, baseGroup: r.base_group, closedAs: r.closed_as, position: r.position });

export function statusRows(projectKey: string): TaskStatusDef[] {
  return (getDb().query("SELECT * FROM task_statuses WHERE project_key = ? ORDER BY position, name").all(projectKey) as StatusRow[]).map(rowToStatus);
}

export function statusById(id: string): TaskStatusDef | null {
  const row = getDb().query("SELECT * FROM task_statuses WHERE id = ?").get(id) as StatusRow | null;
  return row ? rowToStatus(row) : null;
}

interface MemberRow {
  id: string; project_key: string; name: string; jira_account_id: string | null; github_login: string | null;
  slack_user_id: string | null; position: number; archived_at: number | null;
}
export const rowToMember = (r: MemberRow): TaskMember => ({
  id: r.id, projectKey: r.project_key, name: r.name, jiraAccountId: r.jira_account_id, githubLogin: r.github_login,
  slackUserId: r.slack_user_id, position: r.position, archivedAt: r.archived_at,
});

export function memberRows(projectKey: string): TaskMember[] {
  return (getDb().query("SELECT * FROM task_members WHERE project_key = ? ORDER BY position, name").all(projectKey) as MemberRow[]).map(rowToMember);
}

interface FieldDefRow { project_key: string; key: string; label: string; type: FieldType; options_json: string | null; position: number }
export function fieldDefRows(projectKey: string): FieldDef[] {
  return (getDb().query("SELECT * FROM task_field_defs WHERE project_key = ? ORDER BY position, key").all(projectKey) as FieldDefRow[])
    .map((r) => ({ projectKey: r.project_key, key: r.key, label: r.label, type: r.type, options: parseJson(r.options_json, isStringArray as (v: unknown) => v is string[] | null, null), position: r.position }));
}

export interface HistoryRow {
  id: number; task_id: string | null; project_key: string; at: number; actor_kind: HistoryEntry["actor"]["kind"];
  actor_session_id: string | null; actor_label: string; via: HistoryEntry["via"]; unattended: number;
  kind: HistoryEntry["kind"]; changes_json: string; reason: string | null; undo_of: number | null; undone_by: number | null;
}

export const rowToHistory = (r: HistoryRow): HistoryEntry => ({
  id: r.id, taskId: r.task_id, projectKey: r.project_key, at: r.at,
  actor: { kind: r.actor_kind, label: r.actor_label, ...(r.actor_session_id ? { sessionId: r.actor_session_id } : {}) },
  via: r.via, unattended: r.unattended === 1, kind: r.kind,
  changes: parseJson(r.changes_json, Array.isArray as (v: unknown) => v is HistoryEntry["changes"], []),
  reason: r.reason, undoOf: r.undo_of, undoneBy: r.undone_by,
});

interface LinkStateRow { kind: LinkKind; ref: string; state_json: string | null; error: string | null; checked_at: number | null; changed_at: number | null }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const rowToLinkState = (r: LinkStateRow): LinkState => ({
  kind: r.kind, ref: r.ref, state: parseJson<Record<string, unknown> | null>(r.state_json, isObject as (v: unknown) => v is Record<string, unknown> | null, null),
  error: r.error, checkedAt: r.checked_at, changedAt: r.changed_at,
});

/** Cached link states of a project that changed after `atMs` (manager news). */
export function listLinkStateChangesSince(projectKey: string, atMs: number): LinkState[] {
  return (getDb().query("SELECT * FROM task_link_state WHERE project_key = ? AND changed_at > ? ORDER BY changed_at")
    .all(projectKey, atMs) as LinkStateRow[]).map(rowToLinkState);
}

export interface LinkChange { at: number; kind: LinkKind; ref: string }

/**
 * The newest change that wakes a snooze — a Jira issue's status, a PR's state or review — of any
 * Jira or PR link of each task, with the link that changed; tasks with none are absent.
 */
export function lastLinkChanges(tasks: ReadonlyArray<Pick<Task, "id">>): Map<string, LinkChange> {
  const out = new Map<string, LinkChange>();
  const ids = tasks.map((t) => t.id);
  const db = getDb();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.query(
      `SELECT l.task_id AS task_id, l.kind AS kind, l.ref AS ref, s.snooze_changed_at AS changed_at FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       JOIN task_link_state s ON s.kind = l.kind AND s.ref = l.ref AND s.project_key = t.project_key
       WHERE l.task_id IN (${chunk.map(() => "?").join(",")}) AND l.kind IN ('jira', 'pr') AND s.snooze_changed_at IS NOT NULL`,
    ).all(...chunk) as Array<{ task_id: string; kind: LinkKind; ref: string; changed_at: number }>;
    for (const r of rows) {
      const seen = out.get(r.task_id);
      if (!seen || r.changed_at > seen.at) out.set(r.task_id, { at: r.changed_at, kind: r.kind, ref: r.ref });
    }
  }
  return out;
}
