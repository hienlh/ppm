/**
 * Which chat buttons a task view shows. "Open chat" opens the chat the task was handed to; "Ask
 * manager" opens the project's manager chat with the task as a chip in its composer, whichever chat
 * the task was handed to.
 *
 * A task that was not handed off is worked on by the manager chat itself, so "Open chat" would open
 * the very chat "Ask manager" opens, with the same chip: such a task shows "Ask manager" alone. A
 * project with no manager chat shows no "Ask manager" (and nothing creates one from here).
 *
 * No store import, so `bun:test` can load it.
 */
import type { TaskWorkingSession } from "../../../shared/ppm-tasks-api";

/** A chat to open: its session and provider. */
export interface TaskChatRef {
  sessionId: string;
  providerId: string | null;
}

interface ManagerLike { projectName: string; sessionId: string; providerId?: string | null }
interface TaskLike { project: string; workingSession: TaskWorkingSession }

/**
 * The project's manager chat: from the manager chat list, else from the task's own working session
 * (`kind: "manager"`, the server's answer when no chat was handed the task) while the list loads.
 */
export function taskManagerChat(task: TaskLike, managers: readonly ManagerLike[] | null | undefined): TaskChatRef | null {
  const listed = managers?.find((m) => m.projectName === task.project);
  if (listed) return { sessionId: listed.sessionId, providerId: listed.providerId ?? null };
  const w = task.workingSession;
  return w.kind === "manager" ? { sessionId: w.session.sessionId, providerId: w.session.providerId ?? null } : null;
}

export interface TaskChatButtons {
  /** The chat the task was handed to, when it was handed to a chat other than the manager chat. */
  openChat: TaskChatRef | null;
  /** The project's manager chat, when the project has one. */
  askManager: TaskChatRef | null;
}

export function taskChatButtons(task: TaskLike, managers: readonly ManagerLike[] | null | undefined): TaskChatButtons {
  const askManager = taskManagerChat(task, managers);
  const w = task.workingSession;
  const handed = w.kind === "session" && w.session.sessionId !== askManager?.sessionId;
  return {
    openChat: handed ? { sessionId: w.session.sessionId, providerId: w.session.providerId ?? null } : null,
    askManager,
  };
}
