/**
 * Which chat may be a task's working session: a chat PPM knows, of the task's own project, that is
 * neither a PPM Assistant session nor a design chat. Checked when the field is written and again
 * when a decision is delivered, because a choice is sent as an ordinary user turn into that chat —
 * text an AI wrote (the option labels) must never land in another project's chat or the Assistant.
 */
import { getSessionDesignSlug, getSessionProjectPath, resolveMigratedSession } from "../db.service.ts";
import { projectKey as keyOf } from "../project-name-for-path.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";

/** Why `sessionId` cannot be a working session of a task in `projectKey`, or null when it can. */
export function workingSessionRefusal(projectKey: string, sessionId: string): string | null {
  const id = resolveMigratedSession(sessionId);
  const path = getSessionProjectPath(id) ?? getSessionProjectPath(sessionId);
  if (!path) return `No PPM chat ${sessionId}: start the chat in PPM first`;
  if (keyOf(path) !== projectKey) return "The working session must be a chat of the task's own project";
  if (isAssistantSession(id, path)) return "A PPM Assistant session cannot be a task's working session";
  if (getSessionDesignSlug(id)) return "A design chat cannot be a task's working session";
  return null;
}
