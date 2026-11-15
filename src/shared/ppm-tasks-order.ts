/**
 * "What to do first": effective urgency, then importance, then the manual order inside that cell
 * (`rank`, set by drag or by the AI). Ties fall back to the task number so the order is total.
 */
import { IMPORTANCES, URGENCIES, type Importance, type Urgency } from "./ppm-tasks.ts";

export interface OrderableTask {
  effectiveUrgency: Urgency;
  importance: Importance;
  rank: number;
  number: number;
  projectKey?: string;
}

export function compareTasks(a: OrderableTask, b: OrderableTask): number {
  return URGENCIES.indexOf(a.effectiveUrgency) - URGENCIES.indexOf(b.effectiveUrgency)
    || IMPORTANCES.indexOf(a.importance) - IMPORTANCES.indexOf(b.importance)
    || a.rank - b.rank
    || (a.projectKey ?? "").localeCompare(b.projectKey ?? "")
    || a.number - b.number;
}

/** The cell a task's `rank` is ordered within: its project and its stored urgency and importance. */
export function cellKey(t: { projectKey: string; urgency: Urgency; importance: Importance }): string {
  return `${t.projectKey}\u0000${t.urgency}\u0000${t.importance}`;
}

/** Gap below which a cell's ranks are renumbered before a midpoint insert. */
export const RANK_MIN_GAP = 1e-6;

/** The rank between two neighbours (either may be missing, at an end of the cell). */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}
