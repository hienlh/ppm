/**
 * Spec mode's doors into chats, owned by the server: PPM's own messages into a spec's chat (an
 * approval the user gave, a task to run) and the task chats Run all opens. A message goes in the
 * way another session's does (`chat-inject.ts`) — the same registry entry, echo and per-session
 * lock as a browser send — with `spec` as its origin, and never answers a pending approval.
 */
import { resolve } from "node:path";
import { chatService } from "../../services/chat.service.ts";
import { configService } from "../../services/config.service.ts";
import { createLogger } from "../../services/logger.ts";
import {
  getSessionProvider, getSessionTitle, resolveMigratedSession, setSessionMetadata, setSessionPermissionMode, setSessionTitle,
} from "../../services/db.service.ts";
import { recordSpawn } from "../../services/session-collab/session-links.service.ts";
import { setSpecSchedulerEnv } from "../../services/specs/spec-scheduler.ts";
import { announceSessionCreated, announceSessionLinkChanged } from "./chat-inject.ts";
import { ensureSessionEntry, listRunningSessions, startCleanupTimer, submitToSession, withSessionLock } from "./chat.ts";

const log = createLogger("spec");

const projectNameOf = (projectPath: string): string | null =>
  configService.get("projects").find((p) => resolve(p.path) === resolve(projectPath))?.name ?? null;

/** Sends PPM's message into a chat and starts (or joins) its turn. Throws when it did not get in. */
export async function deliverSpecMessage(input: {
  sessionId: string; providerId: string; projectPath: string; projectName: string; text: string;
}): Promise<void> {
  const target = resolveMigratedSession(input.sessionId);
  await withSessionLock(target, async () => {
    const entry = ensureSessionEntry(target, input.providerId, input.projectPath, input.projectName);
    const result = await submitToSession(target, entry, input.text, {
      origin: "spec",
      clientMessageId: `spec-${crypto.randomUUID()}`,
      priority: "next",
      receivedAt: Date.now(),
      supersedePendingApproval: false,
      echoOnHandOff: true,
    });
    if (!result.ok) {
      if (entry.clients.size === 0 && !entry.isStreamingActive) startCleanupTimer(target);
      throw new Error(result.error);
    }
    log.info(`session=${target} spec message ${result.delivered}`);
  });
}

/**
 * Tells a spec's own chat what the user decided in the Spec pane, so the AI goes on without the
 * user typing it. Quietly does nothing for a spec with no chat; a failure is logged, never thrown —
 * the approval itself is already recorded.
 */
export async function tellSpecChat(projectPath: string, sessionId: string | null | undefined, text: string): Promise<boolean> {
  if (!sessionId) return false;
  const providerId = getSessionProvider(sessionId) ?? getSessionProvider(resolveMigratedSession(sessionId));
  const projectName = projectNameOf(projectPath);
  if (!providerId || !projectName) return false;
  try {
    await deliverSpecMessage({ sessionId, providerId, projectPath, projectName, text });
    return true;
  } catch (e) {
    log.warn(`session=${sessionId} could not be told about the spec: ${(e as Error).message}`);
    return false;
  }
}

setSpecSchedulerEnv({
  projectNameOf,
  deliver: deliverSpecMessage,
  isTurnRunning: (sessionId) => {
    const id = resolveMigratedSession(sessionId);
    return chatService.turnActivity(id).running || listRunningSessions().some((s) => s.sessionId === id || s.sessionId === sessionId);
  },
  stopTurn: (providerId, sessionId) => chatService.abortQuery(providerId, resolveMigratedSession(sessionId), "The spec's run was stopped", "spec"),
  async createTaskSession(input) {
    const session = await chatService.createSession(input.providerId, {
      projectName: input.projectName, projectPath: input.projectPath, title: input.title,
    });
    const id = session.id;
    setSessionMetadata(id, input.projectName, input.projectPath);
    setSessionTitle(id, input.title);
    if (input.permissionMode) setSessionPermissionMode(id, input.permissionMode);
    session.title = input.title;
    // A task chat is linked to the spec's chat like a session it created, so its chips show it.
    const parent = input.parentSessionId ? resolveMigratedSession(input.parentSessionId) : null;
    const depth = parent ? recordSpawn(id, parent) : 0;
    announceSessionCreated({
      sessionId: id, providerId: input.providerId, projectName: input.projectName, title: input.title,
      spawnedBy: parent, parentTitle: parent ? getSessionTitle(parent) : null,
      parentProviderId: parent ? getSessionProvider(parent) : null, depth, createdAt: new Date().toISOString(),
    });
    if (parent) announceSessionLinkChanged(input.projectName, [parent, id]);
    return id;
  },
});
