/**
 * Manual order inside a cell (project × stored urgency × importance). A new or moved-in task goes
 * to the end of its cell; a drag puts it at the midpoint of its new neighbours. When two
 * neighbours are closer than `RANK_MIN_GAP` the cell is renumbered first — that only spreads the
 * ranks out, so it bumps no revision and writes no history.
 */
import { getDb } from "../db.service.ts";
import type { Importance, Task, Urgency } from "../../shared/ppm-tasks.ts";
import { RANK_MIN_GAP, rankBetween } from "../../shared/ppm-tasks-order.ts";
import { invalid } from "./ppm-tasks-errors.ts";

interface CellTask { id: string; rank: number }

function cell(projectKey: string, urgency: Urgency, importance: Importance): CellTask[] {
  return getDb().query(
    "SELECT id, rank FROM tasks WHERE project_key = ? AND urgency = ? AND importance = ? AND deleted_at IS NULL ORDER BY rank, number",
  ).all(projectKey, urgency, importance) as CellTask[];
}

/** One past the last rank of the cell (`excludeId` left out: the task being moved). */
export function endOfCellRank(projectKey: string, urgency: Urgency, importance: Importance, excludeId?: string): number {
  const ranks = cell(projectKey, urgency, importance).filter((t) => t.id !== excludeId).map((t) => t.rank);
  return ranks.length ? Math.floor(Math.max(...ranks)) + 1 : 1;
}

function renumber(tasks: CellTask[]): CellTask[] {
  const update = getDb().query("UPDATE tasks SET rank = ? WHERE id = ?");
  return tasks.map((t, i) => {
    update.run(i + 1, t.id);
    return { id: t.id, rank: i + 1 };
  });
}

/** The rank that puts `task` just before `beforeId` or just after `afterId`, in the same cell. */
export function rankForMove(task: Task, to: { beforeId?: string; afterId?: string }): number {
  const anchorId = to.beforeId ?? to.afterId;
  if (!anchorId || (to.beforeId && to.afterId)) throw invalid("Name exactly one of beforeId or afterId");
  if (anchorId === task.id) throw invalid("A task cannot be moved next to itself");
  const neighbours = (list: CellTask[]) => {
    const others = list.filter((t) => t.id !== task.id);
    const at = others.findIndex((t) => t.id === anchorId);
    if (at < 0) throw invalid("Tasks can only be reordered within the same urgency and importance; change those instead");
    const prev = to.beforeId ? others[at - 1] ?? null : others[at]!;
    const next = to.beforeId ? others[at]! : others[at + 1] ?? null;
    return { prev, next };
  };
  let list = cell(task.projectKey, task.urgency, task.importance);
  let { prev, next } = neighbours(list);
  if (prev && next && next.rank - prev.rank < RANK_MIN_GAP) {
    list = renumber(list);
    ({ prev, next } = neighbours(list));
  }
  return rankBetween(prev?.rank ?? null, next?.rank ?? null);
}
