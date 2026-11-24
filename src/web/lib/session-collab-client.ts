/**
 * The browser's half of sessions that open and message each other: answering a create, pair-limit
 * or escalation card, stopping a session's children, and opening a linked session.
 *
 * Answers go over authenticated HTTP, never the chat socket, the same way a database change is
 * approved: the card leaves when `approval_resolved` reaches every device showing the chat.
 */
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { canonicalSessionId } from "@/stores/chat-jump-store";
import { openChatSession } from "./open-chat-session";
import { openTurnRef } from "./open-turn-ref";
import { isAssistantProject } from "../../shared/assistant-project";
import type { SessionCollabAnswer, SessionLink, SessionLinkRelation } from "../../shared/session-collab";

const MAX_DATE_MS = 8.64e15;
const RELATIONS: ReadonlySet<string> = new Set<SessionLinkRelation>(["parent", "child", "messaged"]);

/**
 * Keeps only well-formed links out of a response body: a non-empty id and at least one known
 * relation. Anything else is dropped rather than trusted.
 */
export function parseSessionLinks(body: unknown): SessionLink[] {
  if (!Array.isArray(body)) return [];
  const out: SessionLink[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const { sessionId, relations, lastInteractionAt: at } = item as { sessionId?: unknown; relations?: unknown; lastInteractionAt?: unknown };
    if (typeof sessionId !== "string" || !sessionId || !Array.isArray(relations)) continue;
    const known = relations.filter((r): r is SessionLinkRelation => typeof r === "string" && RELATIONS.has(r));
    // Within what a Date can hold, so a corrupt record cannot throw when the row formats it.
    const time = typeof at === "number" && Number.isFinite(at) && at > 0 && at < MAX_DATE_MS ? { lastInteractionAt: at } : {};
    if (known.length) out.push({ sessionId, relations: [...new Set(known)], ...time });
  }
  return out;
}

/**
 * The links the server holds for a session: its creator, its children, and the sessions it has
 * exchanged messages with — including those from before a restart or older than the loaded
 * messages, which the browser cannot work out by itself.
 */
export async function fetchSessionLinks(projectName: string, sessionId: string, signal?: AbortSignal): Promise<SessionLink[]> {
  const body = await api.get<unknown>(
    `${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/links`,
    signal ? { signal } : undefined,
  );
  return parseSessionLinks(body);
}

/** Answers a session-collaboration card. Rejects with the server's message when it refuses. */
export async function answerCollabApproval(requestId: string, answer: SessionCollabAnswer, remember = false): Promise<void> {
  await api.post(`/api/sessions-collab/approvals/${encodeURIComponent(requestId)}`, { answer, ...(remember ? { remember: true } : {}) });
}

/** Stops every running session this one created (direct children only). */
export async function stopChildSessions(projectName: string, sessionId: string): Promise<void> {
  await api.post(`${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/stop-children`);
}

/**
 * Stop waiting: the session's `wait: true` call on `target` returns now and its turn goes on (every
 * wait of the session when no target is named, as for a create whose new session is not known yet).
 * Nothing is stopped; the other session's reply comes in later as a message. Answers how many waits
 * ended, 0 when the wait was already over.
 */
export async function stopWaiting(projectName: string, sessionId: string, target?: string): Promise<number> {
  const out = await api.post<{ stopped: number }>(
    `${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/stop-waiting`, target ? { target } : {},
  );
  return out.stopped;
}

export interface LinkedSessionTarget {
  projectName: string;
  providerId: string;
  sessionId: string;
  title?: string;
  /** The turn to bring on screen, when known. */
  turnId?: string;
}

/**
 * Shows a linked session: at `turnId` when given, else just its tab. Another project's session
 * opens in a floating window on a desktop (`openChatSession`).
 */
export async function openLinkedSession(target: LinkedSessionTarget): Promise<void> {
  const { providerId } = target;
  // A PPM Assistant session belongs to no project: it opens in the Assistant itself.
  if (isAssistantProject(target.projectName)) {
    // Loaded on use: the window stores it reaches are not needed until the Assistant opens.
    const { openAssistant } = await import("@/components/assistant/open-assistant");
    openAssistant({ sessionId: canonicalSessionId(target.sessionId), providerId });
    return;
  }
  // Only Claude and Codex sessions have turns to jump to.
  if (target.turnId && (providerId === "claude" || providerId === "codex")) {
    await openTurnRef({ ...target, providerId, turnId: target.turnId, title: target.title ?? "Chat" });
    return;
  }
  const sessionId = canonicalSessionId(target.sessionId);
  await openChatSession({ ...target, sessionId }, () => {
    useTabStore.getState().openTab({
      type: "chat",
      title: target.title || "Chat",
      projectId: target.projectName,
      closable: true,
      metadata: { projectName: target.projectName, sessionId, providerId: target.providerId },
    });
    return true;
  });
}

/** "Claude" / "Codex" for a provider id; the id itself for anything else. */
export function providerLabel(providerId: string | undefined): string {
  if (providerId === "claude") return "Claude";
  if (providerId === "codex") return "Codex";
  return providerId || "AI";
}
