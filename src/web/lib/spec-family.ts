/**
 * Chat History's view of a spec chat and its task chats: the progress bar on the spec's row,
 * its counts, and the order its task chats are listed in. Pure, so it is tested without the stores.
 */
import type { SpecSummary, TaskStatus } from "../../shared/spec-types";

export type SpecBarCell = "done" | "running" | "failed" | "todo";

const cellOf = (s: TaskStatus): SpecBarCell =>
  s === "done" ? "done" : s === "running" || s === "red" ? "running" : s === "failed" ? "failed" : "todo";

/** One cell per required task, in tasks.md order. */
export function specBar(spec: SpecSummary): SpecBarCell[] {
  return spec.tasks.filter((t) => !t.optional).map((t) => cellOf(t.status));
}

export function specProgress(spec: SpecSummary) {
  const cells = spec.tasks.map((t) => cellOf(t.status));
  return {
    done: spec.tasksDone,
    total: spec.tasksTotal,
    running: cells.filter((c) => c === "running").length,
    failed: cells.filter((c) => c === "failed").length,
  };
}

/** The task status of each chat that ran a task of this spec. */
export function taskCellBySession(spec: SpecSummary): Map<string, SpecBarCell> {
  return new Map(spec.tasks.filter((t) => t.sessionId).map((t) => [t.sessionId!, cellOf(t.status)]));
}

const RANK: Record<SpecBarCell, number> = { running: 0, failed: 1, done: 2, todo: 2 };

/** Running first, then failed, then the rest; otherwise the list's own order (newest first). */
export function orderTaskChats<T extends { session: { id: string } }>(nodes: T[], cells: Map<string, SpecBarCell>): T[] {
  const rank = (n: T) => RANK[cells.get(n.session.id) ?? "todo"];
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map((x) => x.n);
}
