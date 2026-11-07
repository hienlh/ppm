/**
 * The sessions linked to the one on screen — its creator, the sessions it created, and those it
 * exchanged messages with — each with what it is doing right now. Seeded once per session from
 * the server's link store (which also knows links older than the loaded messages), then live:
 * phase changes, unread marks and `/ws/global`'s link and card events reach it without a request.
 */
import { useEffect, useMemo } from "react";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { useSessionCollabStore } from "@/stores/session-collab-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useNotificationStore } from "@/stores/notification-store";
import {
  collectLinkedSessions, linkedSessionStatus, type LinkedSession, type LinkedSessionStatus,
} from "@/lib/linked-sessions";
import { fetchSessionLinks } from "@/lib/session-collab-client";
import type { SessionLinkRelation } from "../../shared/session-collab";
import type { ChatMessage } from "../../types/chat";

export interface LinkedSessionView extends LinkedSession {
  status: LinkedSessionStatus;
}

const NO_LINKS: Record<string, SessionLinkRelation[]> = {};

/**
 * What one session is doing now, by the same rule as the bar; null with no id. Each store is read
 * down to this session's entry, so a card in a long history re-renders only when its own session
 * changes.
 */
export function useLinkedSessionStatus(sessionId: string | undefined): LinkedSessionStatus | null {
  const running = useStreamingStore((s) => !!sessionId && s.sessions.has(sessionId));
  const unread = useNotificationStore((s) => (sessionId ? s.notifications.get(sessionId) : undefined));
  const approval = useSessionCollabStore((s) => (sessionId ? s.pendingApprovals[sessionId] : undefined));
  if (!sessionId) return null;
  return linkedSessionStatus(sessionId, {
    streaming: running ? new Map([[sessionId, ""]]) : NO_SESSIONS,
    notifications: unread ? new Map([[sessionId, unread]]) : NO_SESSIONS,
    pendingApprovals: approval ? { [sessionId]: approval } : NO_APPROVALS,
  });
}
const NO_SESSIONS = new Map<string, never>();
const NO_APPROVALS: Record<string, string> = {};

export function useLinkedSessions(projectName: string, sessionId: string | null, messages: ChatMessage[]): LinkedSessionView[] {
  const project = useProjectRef(projectName || undefined);
  const id = project ? projectCacheId(project) : null;
  const list = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);
  const liveLinks = useSessionCollabStore((s) => (sessionId ? s.links[sessionId] : undefined) ?? NO_LINKS);
  const announced = useSessionCollabStore((s) => s.announced);
  const pendingApprovals = useSessionCollabStore((s) => s.pendingApprovals);
  const streaming = useStreamingStore((s) => s.sessions);
  const notifications = useNotificationStore((s) => s.notifications);

  useEffect(() => {
    if (!projectName || !sessionId) return;
    const controller = new AbortController();
    fetchSessionLinks(projectName, sessionId, controller.signal)
      .then((links) => {
        if (!controller.signal.aborted && links.length) useSessionCollabStore.getState().seedLinks(sessionId, links);
      })
      .catch((error: unknown) => {
        // The bar still works from the list, the messages and live events; only older links are missing.
        if (!controller.signal.aborted) console.warn("[linked-sessions] could not load links", error);
      });
    return () => controller.abort();
  }, [projectName, sessionId]);

  const linked = useMemo(
    () => (sessionId ? collectLinkedSessions({ sessionId, list, messages, liveLinks, announced }) : []),
    [sessionId, list, messages, liveLinks, announced],
  );
  return useMemo(
    () => linked.map((l) => ({ ...l, status: linkedSessionStatus(l.sessionId, { streaming, notifications, pendingApprovals }) })),
    [linked, streaming, notifications, pendingApprovals],
  );
}
