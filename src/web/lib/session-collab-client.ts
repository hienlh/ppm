/**
 * The browser's half of sessions that open and message each other: answering a create, pair-limit
 * or escalation card, stopping a session's children, and opening a linked session.
 *
 * Answers go over authenticated HTTP, never the chat socket, the same way a database change is
 * approved: the card leaves when `approval_resolved` reaches every device showing the chat.
 */
import { api, projectUrl } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { canonicalSessionId } from "@/stores/chat-jump-store";
import { openSessionAnywhere } from "./open-session-anywhere";
import { openTurnRef } from "./open-turn-ref";
import type { SessionCollabAnswer, SessionLink, SessionLinkRelation } from "../../shared/session-collab";

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
    const { sessionId, relations } = item as { sessionId?: unknown; relations?: unknown };
    if (typeof sessionId !== "string" || !sessionId || !Array.isArray(relations)) continue;
    const known = relations.filter((r): r is SessionLinkRelation => typeof r === "string" && RELATIONS.has(r));
    if (known.length) out.push({ sessionId, relations: [...new Set(known)] });
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
export async function answerCollabApproval(requestId: string, answer: SessionCollabAnswer): Promise<void> {
  await api.post(`/api/sessions-collab/approvals/${encodeURIComponent(requestId)}`, { answer });
}

/** Stops every running session this one created (direct children only). */
export async function stopChildSessions(projectName: string, sessionId: string): Promise<void> {
  await api.post(`${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/stop-children`);
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
 * Shows a linked session: at `turnId` when given, else just its tab. Another project's session is
 * opened through the project switch, like a notification click.
 */
export async function openLinkedSession(target: LinkedSessionTarget): Promise<void> {
  const { providerId } = target;
  // Only Claude and Codex sessions have turns to jump to.
  if (target.turnId && (providerId === "claude" || providerId === "codex")) {
    await openTurnRef({ ...target, providerId, turnId: target.turnId, title: target.title ?? "Chat" });
    return;
  }
  const sessionId = canonicalSessionId(target.sessionId);
  if (target.projectName !== useProjectStore.getState().activeProject?.name) {
    await openSessionAnywhere(target.projectName, sessionId, target.providerId);
    return;
  }
  useTabStore.getState().openTab({
    type: "chat",
    title: target.title || "Chat",
    projectId: target.projectName,
    closable: true,
    metadata: { projectName: target.projectName, sessionId, providerId: target.providerId },
  });
}

/** "Claude" / "Codex" for a provider id; the id itself for anything else. */
export function providerLabel(providerId: string | undefined): string {
  if (providerId === "claude") return "Claude";
  if (providerId === "codex") return "Codex";
  return providerId || "AI";
}
