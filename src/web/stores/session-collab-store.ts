/**
 * What the browser knows about sessions reaching each other: links that `/ws/global` announced
 * since the page loaded (a spawn, a first message between two sessions), links the server already
 * held when a chat was opened (`seedLinks`, from `GET …/sessions/:id/links`), the sessions' titles
 * and providers as announced, and which sessions hold a create, pair-limit or escalation card now.
 *
 * The session list's `spawnedBy` and the chat's own messages are the other sources;
 * `use-linked-sessions.ts` merges them.
 */
import { create } from "zustand";
import type {
  SessionCollabApprovalEvent, SessionCreatedEvent, SessionLink, SessionLinkChangedEvent, SessionLinkRelation,
} from "../../shared/session-collab";

export interface AnnouncedSession {
  title: string;
  providerId: string;
  projectName: string;
}

interface SessionCollabState {
  /** sessionId → other sessionId → how they are linked. Symmetric: both sides are recorded. */
  links: Record<string, Record<string, SessionLinkRelation[]>>;
  /**
   * sessionId → other sessionId → when the two last interacted (epoch ms), as the server's links
   * and the live create and link events said. Symmetric; only ever moves forward.
   */
  interactedAt: Record<string, Record<string, number>>;
  announced: Record<string, AnnouncedSession>;
  /** sessionId → the request id of the card it shows. */
  pendingApprovals: Record<string, string>;
  sessionCreated: (event: SessionCreatedEvent) => void;
  linkChanged: (event: SessionLinkChangedEvent) => void;
  approvalChanged: (event: SessionCollabApprovalEvent) => void;
  /**
   * Merges the links the server holds for `sessionId` (each relation is the other session's, as
   * seen from `sessionId`). Additive: a live link that arrived first is kept, nothing is removed.
   */
  seedLinks: (sessionId: string, links: readonly SessionLink[]) => void;
}

const MIRROR: Record<SessionLinkRelation, SessionLinkRelation> = { parent: "child", child: "parent", messaged: "messaged" };

function addLink(
  links: SessionCollabState["links"], a: string, b: string, relation: SessionLinkRelation,
): SessionCollabState["links"] {
  if (a === b) return links;
  const put = (from: string, to: string, rel: SessionLinkRelation, acc: SessionCollabState["links"]) => {
    const current = acc[from]?.[to] ?? [];
    if (current.includes(rel)) return acc;
    return { ...acc, [from]: { ...acc[from], [to]: [...current, rel] } };
  };
  return put(b, a, MIRROR[relation], put(a, b, relation, links));
}

function stampInteraction(
  times: SessionCollabState["interactedAt"], a: string, b: string, at: number,
): SessionCollabState["interactedAt"] {
  if (a === b || !(at > 0)) return times;
  const put = (from: string, to: string, acc: SessionCollabState["interactedAt"]) =>
    (acc[from]?.[to] ?? 0) >= at ? acc : { ...acc, [from]: { ...acc[from], [to]: at } };
  return put(b, a, put(a, b, times));
}

export const useSessionCollabStore = create<SessionCollabState>((set) => ({
  links: {},
  interactedAt: {},
  announced: {},
  pendingApprovals: {},
  sessionCreated: (event) => set((state) => ({
    announced: {
      ...state.announced,
      // The creator is announced too when the event names it, so a bar or badge that never loaded it has its name.
      ...(event.spawnedBy && event.parentTitle && event.parentProviderId
        ? { [event.spawnedBy]: { title: event.parentTitle, providerId: event.parentProviderId, projectName: event.projectName } }
        : {}),
      [event.sessionId]: { title: event.title, providerId: event.providerId, projectName: event.projectName },
    },
    // The parent sees the new session as its child, and the child its parent.
    links: event.spawnedBy ? addLink(state.links, event.spawnedBy, event.sessionId, "child") : state.links,
    interactedAt: event.spawnedBy
      ? stampInteraction(state.interactedAt, event.spawnedBy, event.sessionId, Date.parse(event.createdAt) || Date.now())
      : state.interactedAt,
  })),
  linkChanged: (event) => set((state) => {
    // The sessions named together are the ones whose link to each other changed: they just talked.
    let links = state.links;
    let interactedAt = state.interactedAt;
    const now = Date.now();
    const ids = event.sessionIds.filter((id) => typeof id === "string" && id);
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        if (!links[a]?.[b]) links = addLink(links, a, b, "messaged");
        interactedAt = stampInteraction(interactedAt, a, b, now);
      }
    }
    return links === state.links && interactedAt === state.interactedAt ? state : { links, interactedAt };
  }),
  approvalChanged: (event) => set((state) => {
    const next = { ...state.pendingApprovals };
    if (event.state === "pending") next[event.sessionId] = event.requestId;
    else if (next[event.sessionId] === event.requestId) delete next[event.sessionId];
    else return state;
    return { pendingApprovals: next };
  }),
  seedLinks: (sessionId, seeded) => set((state) => {
    let links = state.links;
    let interactedAt = state.interactedAt;
    for (const link of seeded) {
      for (const relation of link.relations) links = addLink(links, sessionId, link.sessionId, relation);
      if (link.lastInteractionAt) interactedAt = stampInteraction(interactedAt, sessionId, link.sessionId, link.lastInteractionAt);
    }
    return links === state.links && interactedAt === state.interactedAt ? state : { links, interactedAt };
  }),
}));
