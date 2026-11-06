/**
 * The sessions linked to the one on screen — its creator, the sessions it created, and those it
 * exchanged messages with — each with what it is doing right now. Live: phase changes, unread
 * marks and `/ws/global`'s link and card events all reach it without a request.
 */
import { useMemo } from "react";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { useSessionCollabStore } from "@/stores/session-collab-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useNotificationStore } from "@/stores/notification-store";
import {
  collectLinkedSessions, linkedSessionStatus, type LinkedSession, type LinkedSessionStatus,
} from "@/lib/linked-sessions";
import type { SessionLinkRelation } from "../../shared/session-collab";
import type { ChatMessage } from "../../types/chat";

export interface LinkedSessionView extends LinkedSession {
  status: LinkedSessionStatus;
}

const NO_LINKS: Record<string, SessionLinkRelation[]> = {};

export function useLinkedSessions(projectName: string, sessionId: string | null, messages: ChatMessage[]): LinkedSessionView[] {
  const project = useProjectRef(projectName || undefined);
  const id = project ? projectCacheId(project) : null;
  const list = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);
  const liveLinks = useSessionCollabStore((s) => (sessionId ? s.links[sessionId] : undefined) ?? NO_LINKS);
  const announced = useSessionCollabStore((s) => s.announced);
  const pendingApprovals = useSessionCollabStore((s) => s.pendingApprovals);
  const streaming = useStreamingStore((s) => s.sessions);
  const notifications = useNotificationStore((s) => s.notifications);

  const linked = useMemo(
    () => (sessionId ? collectLinkedSessions({ sessionId, list, messages, liveLinks, announced }) : []),
    [sessionId, list, messages, liveLinks, announced],
  );
  return useMemo(
    () => linked.map((l) => ({ ...l, status: linkedSessionStatus(l.sessionId, { streaming, notifications, pendingApprovals }) })),
    [linked, streaming, notifications, pendingApprovals],
  );
}
