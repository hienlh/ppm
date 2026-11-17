/**
 * The pure half of the task strip at the top of a chat that works on tasks: which tasks it shows,
 * which one leads, and how many hide behind "+N". A chat works on a task when the task names it as
 * its working session; closed and deleted tasks are left out, snoozed ones kept (the strip says
 * so) but put after the rest, since a snoozed task is not what the chat is on now.
 */
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import type { TaskListQuery } from "./ppm-tasks-client";
import { orderTasks } from "./ppm-tasks-list-logic";

/** The list the strip watches for a chat: every project, snoozed included, open only. */
export const chatTasksQuery = (sessionId: string): TaskListQuery => ({ project: "all", session: sessionId, snoozed: true });

export interface ChatTaskStripView {
  /** The task the strip shows: the first in "what to do first" order, snoozed ones last. */
  primary: TaskDto;
  /** Every task the chat works on, in the same order, `primary` first. */
  all: TaskDto[];
  /** How many more than `primary` ("+N"); 0 shows no "+N". */
  extra: number;
}

/** What the strip shows for `tasks`, or null when the chat works on no open task (no strip). */
export function chatTaskStripView(tasks: readonly TaskDto[], sessionId: string): ChatTaskStripView | null {
  const mine = tasks.filter((t) => t.deletedAt === null && t.baseGroup !== "closed" && t.workingSessionId === sessionId);
  if (mine.length === 0) return null;
  const ordered = orderTasks(mine);
  const all = [...ordered.filter((t) => !t.snoozed), ...ordered.filter((t) => t.snoozed)];
  return { primary: all[0]!, all, extra: all.length - 1 };
}

/** The strip's accessible name: "Task #12 Fix login, In progress" (and "+2 more tasks"). */
export function chatTaskStripLabel(view: ChatTaskStripView): string {
  const t = view.primary;
  return `This chat's task: #${t.number} ${t.title}, ${t.statusName}${view.extra ? `, and ${view.extra} more` : ""}`;
}
