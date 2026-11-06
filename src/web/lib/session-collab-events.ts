/**
 * What the browser does with the `/ws/global` events of sessions reaching each other. Kept out of
 * `use-global-events.ts` so it is tested without a socket.
 *
 * Every field is checked before use: the event is the server's, but a malformed one must not put
 * a broken row in the session list.
 */
import { useSessionCollabStore } from "@/stores/session-collab-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { projectRefForName } from "@/stores/session-list-sync-triggers";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import {
  SESSION_COLLAB_APPROVAL_EVENT, SESSION_CREATED_EVENT, SESSION_LINK_CHANGED_EVENT, type SessionCollabGlobalEvent,
} from "../../shared/session-collab";

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function handleSessionCollabEvent(event: SessionCollabGlobalEvent): void {
  const collab = useSessionCollabStore.getState();
  if (event.type === SESSION_CREATED_EVENT) {
    if (!str(event.sessionId) || !str(event.projectName) || !str(event.providerId)) return;
    const title = str(event.title) ? event.title : "Untitled session";
    const spawnedBy = str(event.spawnedBy) ? event.spawnedBy : null;
    // The server names the creator, so the badge is right even when the creator is not loaded here.
    const announcedParent = spawnedBy && str(event.parentTitle) ? event.parentTitle : null;
    const parentProviderId = spawnedBy && str(event.parentProviderId) ? event.parentProviderId : null;
    collab.sessionCreated({ ...event, title, spawnedBy, parentTitle: announcedParent, parentProviderId });
    const project = projectRefForName(event.projectName);
    const list = useSessionListStore.getState();
    const known = list.byProject[projectCacheId(project)]?.sessions ?? [];
    const parentTitle = spawnedBy ? announcedParent ?? known.find((s) => s.id === spawnedBy)?.title ?? null : null;
    const createdAt = str(event.createdAt) ? event.createdAt : new Date().toISOString();
    list.upsertSession(project, {
      id: event.sessionId, providerId: event.providerId, title, projectName: event.projectName,
      createdAt, updatedAt: createdAt, spawnedBy, parentTitle,
    });
    return;
  }
  if (event.type === SESSION_LINK_CHANGED_EVENT) {
    if (!Array.isArray(event.sessionIds)) return;
    collab.linkChanged({ ...event, sessionIds: event.sessionIds.filter(str) });
    return;
  }
  if (event.type === SESSION_COLLAB_APPROVAL_EVENT) {
    if (!str(event.sessionId) || !str(event.requestId) || (event.state !== "pending" && event.state !== "resolved")) return;
    collab.approvalChanged(event);
  }
}
