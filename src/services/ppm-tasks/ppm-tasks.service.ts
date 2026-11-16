/**
 * Every task write goes through here: one transaction holds the revision check, the row change and
 * its history row, so a stale write changes nothing and every change is recorded. Events go out
 * after the commit. Reads are re-exported from `ppm-tasks-read.ts`.
 */
import { getDb } from "../db.service.ts";
import {
  PPM_TASK_LIMITS as L, type ClosedAs, type HistoryChange, type HistoryKind, type Task, type TaskCreateInput,
  type TaskDecision, type TaskPatch, type TaskView, type WriteContext,
} from "../../shared/ppm-tasks.ts";
import { loadTask, statusById } from "./ppm-tasks-db.ts";
import { PpmTaskError, TaskConflictError, invalid, notFound } from "./ppm-tasks-errors.ts";
import { writeHistory } from "./ppm-tasks-history.ts";
import { listStatuses } from "./ppm-tasks-project-config.ts";
import { getTaskProject } from "./ppm-tasks-projects.service.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";
import { getTask } from "./ppm-tasks-read.ts";
import { endOfCellRank, rankForMove } from "./ppm-tasks-rank.ts";
import { checkContext, normalizePatch } from "./ppm-tasks-validate.ts";
import { applyChanges, diffValues, kindForChanges } from "./ppm-tasks-write.ts";

export { getTask, listTasks, taskChildren, listTasksNeedingCheck, childCheckFor, toViews } from "./ppm-tasks-read.ts";

function requireEnabled(projectKey: string): void {
  const project = getTaskProject(projectKey);
  if (!project) throw notFound("Project");
  if (!project.enabled) throw new PpmTaskError("disabled", "Tasks are switched off for this project");
}

function emitTask(task: Pick<Task, "id" | "projectKey">, historyId: number, ctx: WriteContext, kind: HistoryKind): void {
  ppmTasksEvents.emit({
    type: "task", projectKey: task.projectKey, taskIds: [task.id], historyIds: [historyId], actor: ctx.actor, via: ctx.via, kind, unattended: !!ctx.unattended,
  });
}

/**
 * Runs one change: loads the task, checks its revision, builds the changes, writes them and the
 * history row. No change means no history row and no revision bump.
 */
function mutate(
  id: string, expectedRevision: number, ctx: WriteContext, now: number,
  build: (task: Task) => { changes: HistoryChange[]; kind?: HistoryKind },
): TaskView {
  checkContext(ctx);
  let written: { historyId: number; kind: HistoryKind; task: Task } | null = null;
  getDb().transaction(() => {
    const task = loadTask(id);
    if (!task || task.deletedAt !== null) throw notFound("Task");
    requireEnabled(task.projectKey);
    if (task.revision !== expectedRevision) throw new TaskConflictError(task.id, task.revision);
    const { changes, kind } = build(task);
    if (changes.length === 0) return;
    const k = kind ?? kindForChanges(changes);
    applyChanges(task, changes, now);
    written = { historyId: writeHistory({ taskId: task.id, projectKey: task.projectKey, ctx, kind: k, changes, at: now }), kind: k, task };
  })();
  const done = written as { historyId: number; kind: HistoryKind; task: Task } | null;
  if (done) emitTask(done.task, done.historyId, ctx, done.kind);
  return getTask(id)!;
}

/** A patch's changes, with the task moved to the end of its new cell when urgency or importance changed. */
function patchChanges(task: Task, patch: TaskPatch, ctx: WriteContext, now: number): HistoryChange[] {
  const values = normalizePatch(task.projectKey, task.id, patch, ctx, now, task.fields);
  const urgency = (values.get("urgency") as Task["urgency"] | undefined) ?? task.urgency;
  const importance = (values.get("importance") as Task["importance"] | undefined) ?? task.importance;
  if (urgency !== task.urgency || importance !== task.importance) values.set("rank", endOfCellRank(task.projectKey, urgency, importance, task.id));
  return diffValues(task, values);
}

function decisionFrom(input: { question?: string | null; options: string[] }): TaskDecision {
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > L.decisionOptions) {
    throw invalid(`A decision needs 2 to ${L.decisionOptions} options`);
  }
  const options = input.options.map((label, i) => {
    if (typeof label !== "string" || !label.trim() || label.trim().length > L.decisionLabel) throw invalid(`Option ${i + 1} must be 1 to ${L.decisionLabel} characters`);
    return { id: String.fromCharCode(97 + i), label: label.trim() };
  });
  const question = typeof input.question === "string" && input.question.trim() ? input.question.trim().slice(0, L.decisionLabel) : null;
  return { question, options, chosen: null };
}

export function createTask(input: TaskCreateInput, ctx: WriteContext, now: number = Date.now()): TaskView {
  const db = getDb();
  const id = crypto.randomUUID();
  let historyId = 0;
  db.transaction(() => {
    requireEnabled(input.projectKey);
    const { projectKey, title, decision, ...patch } = input;
    const values = normalizePatch(projectKey, null, { ...patch, title }, ctx, now);
    const statuses = listStatuses(projectKey);
    const statusId = (values.get("statusId") as string | undefined) ?? statuses.find((s) => s.baseGroup === "not_started")?.id;
    if (!statusId) throw invalid("The project has no not-started status");
    const urgency = (values.get("urgency") as Task["urgency"] | undefined) ?? "later";
    const importance = (values.get("importance") as Task["importance"] | undefined) ?? "should";
    const dec = decision ? decisionFrom(decision) : null;
    const type = (values.get("type") as string | undefined) ?? (dec ? "decision" : "task");
    const project = db.query("UPDATE task_projects SET next_number = next_number + 1 WHERE project_key = ? RETURNING next_number - 1 AS n").get(projectKey) as { n: number };
    db.query(
      `INSERT INTO tasks (id, project_key, number, title, type, status_id, urgency, importance, rank, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, projectKey, project.n, values.get("title") as string, type, statusId, urgency, importance, endOfCellRank(projectKey, urgency, importance), now, now);
    for (const k of ["title", "type", "statusId", "urgency", "importance"]) values.delete(k);
    if (dec) values.set("decision", dec);
    const blank = loadTask(id)!;
    applyChanges(blank, diffValues(blank, values), now);
    db.query("UPDATE tasks SET revision = 1, closed_at = CASE WHEN closed_at IS NULL AND ? THEN ? ELSE closed_at END WHERE id = ?")
      .run(statusById(statusId)?.baseGroup === "closed" ? 1 : 0, now, id);
    const created = loadTask(id)!;
    const snapshot: HistoryChange[] = [
      { field: "title", before: null, after: created.title }, { field: "statusId", before: null, after: statusId },
      { field: "urgency", before: null, after: urgency }, { field: "importance", before: null, after: importance },
      ...[...values].filter(([, v]) => v !== null).map(([field, after]) => ({ field, before: null, after })),
    ];
    historyId = writeHistory({ taskId: id, projectKey, ctx, kind: "created", changes: snapshot, at: now });
  })();
  emitTask({ id, projectKey: input.projectKey }, historyId, ctx, "created");
  return getTask(id)!;
}

export function updateTask(id: string, patch: TaskPatch, expectedRevision: number, ctx: WriteContext, now: number = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, (task) => ({ changes: patchChanges(task, patch, ctx, now) }));
}

/** Moves the task to a closed status: `statusId` when given, else the first status closing it as `closedAs`. */
export function closeTask(id: string, opts: { closedAs?: ClosedAs; statusId?: string }, expectedRevision: number, ctx: WriteContext, now = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, (task) => {
    const statuses = listStatuses(task.projectKey);
    const target = opts.statusId ? statuses.find((s) => s.id === opts.statusId) : statuses.find((s) => s.baseGroup === "closed" && s.closedAs === (opts.closedAs ?? "done"));
    if (!target || target.baseGroup !== "closed") throw invalid("No such closed status in this project");
    return { changes: patchChanges(task, { statusId: target.id }, ctx, now) };
  });
}

/** Moves a closed task back to an open status (the first not-started one unless named). */
export function reopenTask(id: string, opts: { statusId?: string }, expectedRevision: number, ctx: WriteContext, now = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, (task) => {
    const statuses = listStatuses(task.projectKey);
    const target = opts.statusId ? statuses.find((s) => s.id === opts.statusId) : statuses.find((s) => s.baseGroup === "not_started");
    if (!target || target.baseGroup === "closed") throw invalid("No such open status in this project");
    return { changes: patchChanges(task, { statusId: target.id }, ctx, now) };
  });
}

/** Moves the task within its cell, just before or just after another task of the same cell. */
export function reorderTask(id: string, to: { beforeId?: string; afterId?: string }, expectedRevision: number, ctx: WriteContext, now = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, (task) => ({ changes: [{ field: "rank", before: task.rank, after: rankForMove(task, to) }], kind: "reordered" }));
}

/** Makes the task a decision with these options (replacing any earlier choice). */
export function setTaskDecision(id: string, input: { question?: string | null; options: string[] }, expectedRevision: number, ctx: WriteContext, now = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, (task) => {
    const values = new Map<string, unknown>([["decision", decisionFrom(input)]]);
    if (task.type !== "decision") values.set("type", "decision");
    return { changes: diffValues(task, values), kind: "decision" };
  });
}

/** Records the user's choice on a decision task. Sending it to the working chat is `deliverDecision`. */
export function decideTask(id: string, optionId: string, expectedRevision: number, ctx: WriteContext, now = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, (task) => {
    if (!task.decision) throw invalid("This task is not a decision");
    if (!task.decision.options.some((o) => o.id === optionId)) throw invalid(`No option ${optionId} on this decision`);
    const decision: TaskDecision = { ...task.decision, chosen: { optionId, at: now, by: ctx.actor.label } };
    return { changes: [{ field: "decision", before: task.decision, after: decision }], kind: "decided" };
  });
}

/** Hides the task everywhere; the row and its history stay. */
export function softDeleteTask(id: string, expectedRevision: number, ctx: WriteContext, now = Date.now()): TaskView {
  return mutate(id, expectedRevision, ctx, now, () => ({ changes: [{ field: "deletedAt", before: null, after: now }], kind: "deleted" }));
}
