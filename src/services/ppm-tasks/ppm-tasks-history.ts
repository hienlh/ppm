/**
 * Task history: one row per change, written in the change's own transaction, and undo of an AI
 * change. Undo is allowed for 90 days and only while every field it touched still holds the value
 * that change wrote — a field changed since means someone acted on it, and undo would silently
 * throw their change away. Undoing an AI `created` soft-deletes the task, only while nothing else
 * has changed it.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import {
  AI_ACTOR_KINDS, HISTORY_DETAIL_DAYS, type HistoryChange, type HistoryEntry, type HistoryKind, type WriteContext,
} from "../../shared/ppm-tasks.ts";
import { loadTask, rowToHistory, type HistoryRow } from "./ppm-tasks-db.ts";
import { PpmTaskError, notFound } from "./ppm-tasks-errors.ts";
import { checkContext, normalizePatch } from "./ppm-tasks-validate.ts";
import { applyChanges, currentValue, sameValue } from "./ppm-tasks-write.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";

const DAY = 86_400_000;

export interface HistoryWrite {
  taskId: string | null;
  projectKey: string;
  ctx: WriteContext;
  kind: HistoryKind;
  changes: HistoryChange[];
  at: number;
  undoOf?: number;
}

/** Writes one history row; returns its id. Call inside the change's transaction. */
export function writeHistory(h: HistoryWrite): number {
  const result = getDb().query(
    `INSERT INTO task_history (task_id, project_key, at, actor_kind, actor_session_id, actor_label, via, unattended, kind, changes_json, reason, undo_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    h.taskId, h.projectKey, h.at, h.ctx.actor.kind, h.ctx.actor.sessionId ?? null, h.ctx.actor.label, h.ctx.via,
    h.ctx.unattended ? 1 : 0, h.kind, JSON.stringify(h.changes), h.ctx.reason ?? null, h.undoOf ?? null,
  );
  return Number(result.lastInsertRowid);
}

export interface HistoryQuery {
  /** Only changes made by AI (manager, Assistant, chat). */
  aiOnly?: boolean;
  /** Only the key events (created, status moves, closed, reopened). */
  statusOnly?: boolean;
  limit?: number;
}

/** A task's history, newest first. */
export function taskHistory(taskId: string, q: HistoryQuery = {}): HistoryEntry[] {
  const where = ["task_id = ?"];
  const args: Array<string | number> = [taskId];
  if (q.aiOnly) {
    where.push(`actor_kind IN (${AI_ACTOR_KINDS.map(() => "?").join(",")})`);
    args.push(...AI_ACTOR_KINDS);
  }
  if (q.statusOnly) where.push("kind IN ('created','status','closed','reopened')");
  args.push(Math.min(Math.max(q.limit ?? 200, 1), 1000));
  return (getDb().query(`SELECT * FROM task_history WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args) as HistoryRow[])
    .map(rowToHistory);
}

export function historyRow(id: number): HistoryEntry | null {
  const row = getDb().query("SELECT * FROM task_history WHERE id = ?").get(id) as HistoryRow | null;
  return row ? rowToHistory(row) : null;
}

/** Why `entry` cannot be undone now, or null when it can. */
export function undoRefusal(entry: HistoryEntry, now: number): string | null {
  if (!entry.taskId) return "Project settings changes cannot be undone";
  if (entry.kind === "undo") return "An undo cannot itself be undone";
  if (!AI_ACTOR_KINDS.includes(entry.actor.kind)) return "Only changes made by AI can be undone";
  if (entry.undoneBy !== null) return "This change was already undone";
  if (now - entry.at > HISTORY_DETAIL_DAYS * DAY) return `Changes older than ${HISTORY_DETAIL_DAYS} days cannot be undone`;
  const task = loadTask(entry.taskId);
  // A deleted task can still have its own deletion undone (and an AI create, below).
  if (!task || (task.deletedAt !== null && entry.kind !== "created" && entry.kind !== "deleted")) return "The task no longer exists";
  const enabled = getDb().query("SELECT enabled FROM task_projects WHERE project_key = ?").get(task.projectKey) as { enabled: number } | null;
  if (enabled?.enabled !== 1) return "Tasks are switched off for this project";
  if (entry.kind === "created") {
    if (task.deletedAt !== null) return "The task is already deleted";
    const later = getDb().query("SELECT COUNT(*) AS n FROM task_history WHERE task_id = ? AND id > ?").get(entry.taskId, entry.id) as { n: number };
    return later.n > 0 ? "The task changed after it was created" : null;
  }
  for (const c of entry.changes) {
    if (!sameValue(comparable(c.field, currentValue(task, c.field)), comparable(c.field, c.after))) return `${c.field} changed since`;
  }
  return null;
}

/** A session id compared under the id it answers to now: a provider rename is no change. */
const comparable = (field: string, value: unknown): unknown =>
  field === "workingSessionId" && typeof value === "string" ? resolveMigratedSession(value) : value;

/** References an undo would put back must still be valid now (status, parent, members, session). */
const RECHECKED = ["statusId", "parentId", "assigneeMemberId", "waitingOnMemberId", "workingSessionId"] as const;

function recheckRestored(projectKey: string, taskId: string, restore: HistoryChange[], ctx: WriteContext, now: number): void {
  const patch: Record<string, unknown> = {};
  for (const c of restore) if ((RECHECKED as readonly string[]).includes(c.field) && c.after !== null) patch[c.field] = c.after;
  if (Object.keys(patch).length === 0) return;
  try {
    normalizePatch(projectKey, taskId, patch, ctx, now);
  } catch (e) {
    throw new PpmTaskError("forbidden", `Cannot undo: ${(e as Error).message}`);
  }
}

/** Undoes an AI change; returns the undo row's id. Throws `forbidden` with the reason when it cannot. */
export function undoChange(historyId: number, ctx: WriteContext, now: number = Date.now()): number {
  checkContext(ctx);
  const db = getDb();
  let undoId = 0;
  let projectKey = "";
  let taskId = "";
  db.transaction(() => {
    const entry = historyRow(historyId);
    if (!entry) throw notFound("History entry");
    const refusal = undoRefusal(entry, now);
    if (refusal) throw new PpmTaskError("forbidden", refusal);
    const task = loadTask(entry.taskId!)!;
    projectKey = task.projectKey;
    taskId = task.id;
    const changes: HistoryChange[] = entry.kind === "created"
      ? [{ field: "deletedAt", before: null, after: now }]
      : entry.changes.map((c) => ({ field: c.field, before: c.after, after: c.before }));
    recheckRestored(task.projectKey, task.id, changes, ctx, now);
    applyChanges(task, changes, now);
    undoId = writeHistory({ taskId: task.id, projectKey, ctx, kind: "undo", changes, at: now, undoOf: entry.id });
    db.query("UPDATE task_history SET undone_by = ? WHERE id = ?").run(undoId, entry.id);
  })();
  ppmTasksEvents.emit({
    type: "task", projectKey, taskIds: [taskId], historyIds: [undoId], actor: ctx.actor, via: ctx.via, kind: "undo", unattended: !!ctx.unattended,
  });
  return undoId;
}
