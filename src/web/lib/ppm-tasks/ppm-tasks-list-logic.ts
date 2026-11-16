/**
 * The pure half of the PPM Tasks store: list keys, "what to do first" ordering, client-side
 * filtering, and folding one changed task into a list it may or may not still belong to. Kept out
 * of the zustand store so it can be tested without a browser.
 */
import { compareTasks } from "../../../shared/ppm-tasks-order";
import type { BaseGroup } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import type { TaskListQuery } from "./ppm-tasks-client";

/** One stable key per distinct list query (field order and list order do not matter). */
export function listKey(q: TaskListQuery): string {
  const sorted = (xs?: string[]) => (xs?.length ? [...xs].sort().join(",") : "");
  return [q.project, sorted(q.groups), sorted(q.types), q.person ?? "", q.tag ?? "", q.q?.trim().toLowerCase() ?? "", q.closed ? "1" : "0"].join("|");
}

/** "What to do first": effective urgency, importance, manual order. Returns a new array. */
export const orderTasks = (tasks: readonly TaskDto[]): TaskDto[] => [...tasks].sort(compareTasks);

/** Whether a task belongs in a list asked for with `q` (the same rules the server applies). */
export function matchesQuery(t: TaskDto, q: TaskListQuery): boolean {
  if (t.deletedAt !== null) return false;
  if (q.project !== "all" && t.project !== q.project) return false;
  const closedAsked = q.closed || q.groups?.includes("closed");
  if (!closedAsked && t.baseGroup === "closed") return false;
  if (q.groups?.length && !q.groups.includes(t.baseGroup as BaseGroup)) return false;
  if (q.types?.length && !q.types.includes(t.type)) return false;
  if (q.person && t.assigneeMemberId !== q.person && t.waitingOnMemberId !== q.person) return false;
  if (q.tag && !t.tags.includes(q.tag)) return false;
  const text = q.q?.trim().toLowerCase();
  if (text && ![t.title, t.why, t.nextStep, t.notes].some((s) => s?.toLowerCase().includes(text))) return false;
  return true;
}

/**
 * The list after one task changed: replaced where it was, added if it now matches, dropped if it
 * no longer does, then put back in order.
 */
export function foldTask(tasks: readonly TaskDto[], changed: TaskDto, q: TaskListQuery): TaskDto[] {
  const rest = tasks.filter((t) => t.id !== changed.id);
  return orderTasks(matchesQuery(changed, q) ? [...rest, changed] : rest);
}

/** Whether a change in `project` concerns a list asked for with `q`. */
export const listCovers = (q: TaskListQuery, project: string): boolean => q.project === "all" || q.project === project;

/** The first `limit` open tasks in "what to do first" order. */
export function whatToDoFirst(tasks: readonly TaskDto[], limit = 10): TaskDto[] {
  return orderTasks(tasks.filter((t) => t.baseGroup !== "closed" && t.deletedAt === null)).slice(0, limit);
}

/** Tasks grouped by project, projects in first-appearance order (for the all-projects view). */
export function groupByProject(tasks: readonly TaskDto[]): Array<{ project: string; tasks: TaskDto[] }> {
  const groups = new Map<string, TaskDto[]>();
  for (const t of tasks) {
    const list = groups.get(t.project);
    if (list) list.push(t);
    else groups.set(t.project, [t]);
  }
  return [...groups].map(([project, list]) => ({ project, tasks: list }));
}
