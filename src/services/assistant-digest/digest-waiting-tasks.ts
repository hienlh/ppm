/**
 * The waiting tasks a morning digest section lists under the manager's items: every open task of
 * the project that waits, the ones waiting on the user first, each worded with on whom and until
 * when (its due date, else how long it has waited). PPM reads them from the task store itself when
 * it puts the digest together, so this part of the card is never a model's words.
 */
import { DIGEST_WAITING_MAX, type DigestProject, type DigestWaitingTask } from "../../shared/assistant-digest.ts";
import { isWaitingTask, waitingDetail, waitingUntilText } from "../../shared/ppm-tasks-waiting.ts";
import type { TaskView } from "../../shared/ppm-tasks.ts";

export interface DigestWaitingContext {
  /** `ppm/12` for a task. */
  ref(task: TaskView): string;
  /** A member's name for an id other than the user's. */
  nameOf(task: TaskView, memberId: string): string | null;
  /** The task's status name ("Blocked" is said instead of "Waiting"). */
  statusName(task: TaskView): string | null;
  /** The user's date (`YYYY-MM-DD`). */
  today: string;
  now: number;
}

/**
 * The digest's waiting part of one project, from its open tasks in "what to do first" order;
 * nothing at all when no task waits.
 */
export function digestWaiting(tasks: readonly TaskView[], ctx: DigestWaitingContext, max = DIGEST_WAITING_MAX): Pick<DigestProject, "waiting" | "waitingMore" | "waitingMine"> {
  const rows: DigestWaitingTask[] = [];
  for (const t of tasks) {
    if (t.deletedAt !== null || !isWaitingTask(t)) continue;
    const w = waitingDetail({ ...t, statusName: ctx.statusName(t) }, (id) => ctx.nameOf(t, id));
    if (!w) continue;
    rows.push({ ref: ctx.ref(t), title: t.title, label: w.label, mine: w.mine, until: waitingUntilText(w.until, ctx.today, ctx.now) });
  }
  if (rows.length === 0) return {};
  // The user's own waits first; the order among each kind stays "what to do first".
  const ordered = [...rows.filter((r) => r.mine), ...rows.filter((r) => !r.mine)];
  const listed = ordered.slice(0, max);
  return {
    waiting: listed,
    ...(ordered.length > listed.length ? { waitingMore: ordered.length - listed.length } : {}),
    waitingMine: rows.filter((r) => r.mine).length,
  };
}
