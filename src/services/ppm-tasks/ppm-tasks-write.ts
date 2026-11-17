/**
 * The one place a task row is changed: diffs stored values against a task, writes the changed
 * columns and links, keeps the derived columns in step (closed, waiting since, handed off) and
 * bumps the revision. Callers run it inside their transaction and write the history row.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import type { HistoryChange, HistoryKind, Task, TaskDecision, TaskLink } from "../../shared/ppm-tasks.ts";
import { statusById } from "./ppm-tasks-db.ts";

/** Change field → tasks column, for the plain columns. */
const COLUMNS: Record<string, string> = {
  title: "title", type: "type", statusId: "status_id", urgency: "urgency", importance: "importance",
  why: "why", nextStep: "next_step", notes: "notes", dueDate: "due_date", assigneeMemberId: "assignee_member_id",
  waitingOnMemberId: "waiting_on_member_id", parentId: "parent_id", workingSessionId: "working_session_id",
  snoozedUntil: "snoozed_until",
};

/** Change fields that set or clear a snooze. */
export const SNOOZE_FIELDS: readonly string[] = ["snoozedUntil", "snoozeUntilChange"];

/** The value a change field has on the task now. */
export function currentValue(task: Task, field: string): unknown {
  if (field.startsWith("fields.")) return task.fields[field.slice(7)] ?? null;
  if (field === "links") return task.links.map((l) => ({ kind: l.kind, ref: l.ref, label: l.label }));
  if (field === "tags") return task.tags;
  return (task as unknown as Record<string, unknown>)[field] ?? null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const sameValue = same;

/** The changes `values` would make to `task`; unchanged fields are left out. */
export function diffValues(task: Task, values: Map<string, unknown>): HistoryChange[] {
  const changes: HistoryChange[] = [];
  for (const [field, after] of values) {
    const before = currentValue(task, field);
    if (!same(before, after)) changes.push({ field, before, after });
  }
  return changes;
}

/** The project's manager chat, or null. */
export function managerSessionFor(projectKey: string): string | null {
  const row = getDb().query("SELECT session_id FROM manager_chats WHERE project_key = ?").get(projectKey) as { session_id: string } | null;
  return row ? resolveMigratedSession(row.session_id) : null;
}

/** Whether `sessionId` is a chat other than the project's manager, i.e. the task is handed off. */
export function isHandedOff(projectKey: string, sessionId: string | null): boolean {
  if (!sessionId) return false;
  const manager = managerSessionFor(projectKey);
  return !manager || resolveMigratedSession(sessionId) !== manager;
}

/** Writes `changes` to the task (columns, links, derived columns) and bumps its revision. */
export function applyChanges(task: Task, changes: HistoryChange[], now: number): void {
  if (changes.length === 0) return;
  const db = getDb();
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); args.push(value); };
  let fields: Record<string, unknown> | null = null;
  for (const { field, after } of changes) {
    if (COLUMNS[field]) set(COLUMNS[field]!, after as string | null);
    else if (field === "tags") set("tags_json", JSON.stringify(after ?? []));
    else if (field === "decision") set("decision_json", after ? JSON.stringify(after) : null);
    else if (field === "result") {
      const r = after as Task["result"];
      set("result_text", r?.text ?? null); set("result_at", r?.at ?? null); set("result_by", r?.by ?? null);
    } else if (field.startsWith("fields.")) {
      fields ??= { ...task.fields };
      if (after === null) delete fields[field.slice(7)];
      else fields[field.slice(7)] = after;
    } else if (field === "links") writeLinks(task.id, after as TaskLink[], now);
    else if (field === "deletedAt") set("deleted_at", after as number | null);
    else if (field === "rank") set("rank", after as number);
    else if (field === "snoozeUntilChange") set("snooze_until_change", after ? 1 : 0);
    else if (field === "resurfacedAt") set("resurfaced_at", after as number | null);
  }
  if (fields) set("fields_json", Object.keys(fields).length ? JSON.stringify(fields) : null);
  const changed = (f: string) => changes.find((c) => c.field === f);
  const status = changed("statusId");
  if (status) {
    const closed = statusById(status.after as string)?.baseGroup === "closed";
    set("closed_at", closed ? (task.closedAt ?? now) : null);
  }
  const waiting = changed("waitingOnMemberId");
  if (waiting) set("waiting_since", waiting.after ? now : null);
  const working = changed("workingSessionId");
  if (working) set("handed_off_at", isHandedOff(task.projectKey, working.after as string | null) ? now : null);
  // A new snooze starts its clock (a link change is compared with it) and forgets the last return.
  const until = changed("snoozedUntil");
  const onChange = changed("snoozeUntilChange");
  if (until || onChange) {
    const snoozedAfter = (until ? until.after !== null : task.snoozedUntil !== null) || (onChange ? onChange.after === true : task.snoozeUntilChange);
    set("snoozed_at", snoozedAfter ? now : null);
    if (snoozedAfter && !changed("resurfacedAt")) set("resurfaced_at", null);
  }
  set("updated_at", now);
  args.push(task.id);
  db.query(`UPDATE tasks SET ${sets.join(", ")}, revision = revision + 1 WHERE id = ?`).run(...args);
}

/** Replaces the task's links, keeping each surviving link's original `added_at`. */
export function writeLinks(taskId: string, links: TaskLink[], now: number): void {
  const db = getDb();
  const kept = new Map((db.query("SELECT kind, ref, added_at FROM task_links WHERE task_id = ?").all(taskId) as Array<{ kind: string; ref: string; added_at: number }>)
    .map((r) => [`${r.kind}\u0000${r.ref}`, r.added_at]));
  db.query("DELETE FROM task_links WHERE task_id = ?").run(taskId);
  const insert = db.query("INSERT INTO task_links (id, task_id, kind, ref, label, position, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  links.forEach((l, i) => insert.run(crypto.randomUUID(), taskId, l.kind, l.ref, l.label ?? null, i, kept.get(`${l.kind}\u0000${l.ref}`) ?? now));
}

/** The history kind a set of changes is recorded as; a status move into or out of closed is a key event. */
export function kindForChanges(changes: HistoryChange[]): HistoryKind {
  const status = changes.find((c) => c.field === "statusId");
  if (status) {
    const was = statusById(status.before as string)?.baseGroup === "closed";
    const now = statusById(status.after as string)?.baseGroup === "closed";
    return now && !was ? "closed" : was && !now ? "reopened" : "status";
  }
  if (changes.every((c) => c.field === "result")) return "result";
  if (changes.every((c) => c.field === "decision")) return (changes[0]!.after as TaskDecision | null)?.chosen ? "decided" : "decision";
  if (changes.every((c) => c.field === "rank")) return "reordered";
  if (changes.every((c) => SNOOZE_FIELDS.includes(c.field))) return "snoozed";
  return "updated";
}
