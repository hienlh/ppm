/**
 * Live state of a chat a task points at: read from the chat layer every time, never cached. A chat
 * PPM has no record of any more reads as `gone`; one with no live entry in this process is idle (an
 * entry is dropped once a chat has been idle and unwatched for a while). The chat is only looked at:
 * nothing here sends it anything.
 */
import { chatControl, type ChatControl } from "../../chat-control/chat-control.ts";
import { getSessionProjectPath, getSessionProvider, getSessionTitle, resolveMigratedSession } from "../../db.service.ts";
import type { SessionLinkState } from "../ppm-tasks-link-state-source.ts";
import { managerSessionFor } from "../ppm-tasks-write.ts";
import { childCheckFor } from "../ppm-tasks-read.ts";
import type { Task, TaskChildCheck } from "../../../shared/ppm-tasks.ts";

export interface SessionReaderEnv {
  chat(): ChatControl | null;
}
let env: SessionReaderEnv = { chat: chatControl };

/** Tests swap the chat door; null puts the live one back. */
export function setSessionReaderEnv(next: SessionReaderEnv | null): void {
  env = next ?? { chat: chatControl };
}

/** What a task row shows about the last check of its handed-off chat. */
export function checkSummary(check: TaskChildCheck | null, handedOffAt: number | null): SessionLinkState["check"] {
  if (!check) return null;
  // Stalled, running and finished all count from the last sign of progress (the hand-off when
  // there was none); a card on screen is as old as the check that saw it.
  const since = check.state === "waiting_card" ? check.checkedAt : check.lastProgressAt ?? handedOffAt ?? check.checkedAt;
  return { state: check.state, since, lastProgressAt: check.lastProgressAt };
}

/** The chat's state now. With `task`, the last check of that task's handed-off chat comes along. */
export function readSessionState(sessionId: string, task?: Pick<Task, "id" | "workingSessionId" | "handedOffAt"> | null): SessionLinkState {
  const id = resolveMigratedSession(sessionId);
  const base = { sessionId: id, title: getSessionTitle(id), providerId: getSessionProvider(id) };
  const check = task && task.workingSessionId === id ? checkSummary(childCheckFor(task), task.handedOffAt) : null;
  if (!getSessionProjectPath(id)) return { ...base, state: "gone", check };
  const live = env.chat()?.liveState(id) ?? null;
  if (live?.card) return { ...base, state: "waiting_card", check, ...(live.runningSince ? { runningSince: live.runningSince } : {}) };
  if (live?.running) return { ...base, state: "running", check, ...(live.runningSince ? { runningSince: live.runningSince } : {}) };
  return { ...base, state: "idle", check };
}

/**
 * Who works on a task, as its row shows it: the working chat when one is set, else the project's
 * manager chat (labelled "Manager"), else nobody — the row then offers to start a chat.
 */
export type WorkingSession =
  | { kind: "session"; session: SessionLinkState }
  | { kind: "manager"; label: "Manager"; session: SessionLinkState }
  | { kind: "start_chat" };

export function workingSessionFor(task: Pick<Task, "id" | "projectKey" | "workingSessionId" | "handedOffAt">): WorkingSession {
  if (task.workingSessionId) return { kind: "session", session: readSessionState(task.workingSessionId, task) };
  const manager = managerSessionFor(task.projectKey);
  return manager ? { kind: "manager", label: "Manager", session: readSessionState(manager) } : { kind: "start_chat" };
}
