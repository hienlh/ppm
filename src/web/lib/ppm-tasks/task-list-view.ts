/**
 * The Tasks sidebar list as pure functions: which query the filters ask the server for, what the
 * server cannot filter (a declared field, hidden projects), the Now / Today / This week / Later
 * groups, children nested under their parent, the row order arrow keys walk, and what a drag
 * means once dropped. The components only draw what these return.
 */
import { cellKey } from "../../../shared/ppm-tasks-order";
import { URGENCIES, type Urgency } from "../../../shared/ppm-tasks";
import { matchesTaskCode, parseTaskCodeQuery } from "../../../shared/ppm-tasks-refs";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import type { TaskListQuery } from "./ppm-tasks-client";
import { orderTasks } from "./ppm-tasks-list-logic";
import type { TaskScope, TaskViewFilters } from "@/stores/ppm-tasks-view-store";

/**
 * The server query for a scope and the filters (closed tasks always come, for child progress).
 * A search that is a task code (`#82`, `ppm/82`) asks for the whole scope, filters left out: the
 * code names one task, which `visibleTasks` then picks whatever the filters say.
 */
export function listQueryFor(scope: TaskScope, project: string | null, f: TaskViewFilters, q: string): TaskListQuery | null {
  const name = scope === "all" ? "all" : project;
  if (!name) return null;
  if (parseTaskCodeQuery(q)) return { project: name, closed: true };
  return {
    project: name,
    ...(f.groups.length ? { groups: f.groups } : {}),
    ...(f.types.length ? { types: f.types } : {}),
    ...(f.person ? { person: f.person } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    closed: true,
  };
}

/**
 * The scope's every task, filters and search left out: what child progress (`1/3`) and the tag
 * and field pickers count, so neither shrinks to whatever the filters let through. With no
 * server-side filter on it is the same list as `listQueryFor`'s, so one request serves both.
 */
export function countingQueryFor(scope: TaskScope, project: string | null): TaskListQuery | null {
  return listQueryFor(scope, project, { groups: [], types: [], person: null, tag: null, field: null }, "");
}

/**
 * What the list shows: the server's answer less closed tasks (unless asked), hidden projects and a
 * field filter. A search that is a task code shows the task it names and nothing else, closed or
 * not: the code was typed to find that one task.
 */
export function visibleTasks(tasks: readonly TaskDto[], f: TaskViewFilters, hiddenProjects: readonly string[], scope: TaskScope, q = ""): TaskDto[] {
  const code = parseTaskCodeQuery(q);
  if (code) return tasks.filter((t) => t.deletedAt === null && matchesTaskCode(t, code));
  const closedAsked = f.groups.includes("closed");
  return tasks.filter((t) => {
    if (t.baseGroup === "closed" && !closedAsked) return false;
    if (scope === "all" && hiddenProjects.includes(t.project)) return false;
    if (f.field) {
      const v = t.fields[f.field.key];
      if (v === null || v === undefined || String(v) !== f.field.value) return false;
    }
    return true;
  });
}

/** Closed / all children per parent id, over every task the server sent (closed ones included). */
export function childProgress(tasks: readonly TaskDto[]): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (!t.parentId || t.deletedAt !== null) continue;
    const p = out.get(t.parentId) ?? { done: 0, total: 0 };
    p.total++;
    if (t.baseGroup === "closed") p.done++;
    out.set(t.parentId, p);
  }
  return out;
}

export interface TaskListRowItem {
  task: TaskDto;
  /** 0 for a top-level row, 1 for a child shown under its expanded parent. */
  depth: 0 | 1;
}

export interface TaskListGroup {
  urgency: Urgency;
  rows: TaskListRowItem[];
  /** Top-level rows only (what the group header counts). */
  count: number;
}

/**
 * Groups by effective urgency in "what to do first" order. A child whose parent is in the list
 * is not a row of its own: it shows indented under its parent while the parent is expanded.
 */
export function groupTasks(tasks: readonly TaskDto[], expanded: ReadonlySet<string>): TaskListGroup[] {
  const ordered = orderTasks(tasks);
  const ids = new Set(ordered.map((t) => t.id));
  const childrenOf = new Map<string, TaskDto[]>();
  for (const t of ordered) {
    if (t.parentId && ids.has(t.parentId)) childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
  }
  return URGENCIES.map((urgency) => {
    const top = ordered.filter((t) => t.effectiveUrgency === urgency && !(t.parentId && ids.has(t.parentId)));
    const rows: TaskListRowItem[] = [];
    for (const t of top) {
      rows.push({ task: t, depth: 0 });
      if (expanded.has(t.id)) for (const c of childrenOf.get(t.id) ?? []) rows.push({ task: c, depth: 1 });
    }
    return { urgency, rows, count: top.length };
  });
}

/** Every row in screen order, for arrow keys. */
export const flatRows = (groups: readonly TaskListGroup[]): TaskDto[] => groups.flatMap((g) => g.rows.map((r) => r.task));

/** The row an arrow key lands on: the next or previous one, staying put at an end; the first with nothing selected. */
export function stepSelection(rows: readonly TaskDto[], selectedId: string | null, delta: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const at = selectedId ? rows.findIndex((t) => t.id === selectedId) : -1;
  if (at < 0) return (delta === 1 ? rows[0] : rows[rows.length - 1])!.id;
  return rows[Math.min(rows.length - 1, Math.max(0, at + delta))]!.id;
}

export type DropPlan =
  /** Same cell: put it next to a neighbour of that cell. */
  | { kind: "reorder"; to: { beforeId: string } | { afterId: string } }
  /** Another urgency group: the urgency changes (and the task goes to the end of its new cell). */
  | { kind: "urgency"; urgency: Urgency }
  | { kind: "none"; reason: string | null };

/**
 * What dropping `dragged` at `index` of group `target` (the group's top-level rows, `dragged`
 * removed) asks for. Rank only orders inside one cell (project, stored urgency, importance), so
 * the anchor is the nearest row of the dragged task's cell on either side of the drop point.
 */
export function planDrop(dragged: TaskDto, target: Urgency, groupRows: readonly TaskDto[], index: number): DropPlan {
  if (target !== dragged.effectiveUrgency) {
    // Stored already, yet shown higher: the due date raised it, and would raise it again.
    if (target === dragged.urgency) return { kind: "none", reason: "Its due date keeps it more urgent: change the due date first" };
    return { kind: "urgency", urgency: target };
  }
  const rows = groupRows.filter((t) => t.id !== dragged.id);
  const cell = cellKey(dragged);
  const after = rows.slice(index).find((t) => cellKey(t) === cell);
  if (after) return { kind: "reorder", to: { beforeId: after.id } };
  const before = [...rows.slice(0, index)].reverse().find((t) => cellKey(t) === cell);
  if (before) return { kind: "reorder", to: { afterId: before.id } };
  return { kind: "none", reason: "Order changes only among tasks of the same importance and project" };
}

/** Whether a drop would leave the task where it is (no write needed). */
export function dropIsNoop(dragged: TaskDto, groupRows: readonly TaskDto[], plan: DropPlan): boolean {
  if (plan.kind !== "reorder") return plan.kind === "none";
  const ids = groupRows.map((t) => t.id);
  const at = ids.indexOf(dragged.id);
  if ("beforeId" in plan.to) return ids[at + 1] === plan.to.beforeId;
  return ids[at - 1] === plan.to.afterId;
}
