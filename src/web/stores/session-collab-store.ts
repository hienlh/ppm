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

export const useSessionCollabStore = create<SessionCollabState>((set) => ({
  links: {},
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
  })),
  linkChanged: (event) => set((state) => {
    // The sessions named together are the ones whose link to each other changed.
    let links = state.links;
    const ids = event.sessionIds.filter((id) => typeof id === "string" && id);
    for (const a of ids) for (const b of ids) if (a < b && !links[a]?.[b]) links = addLink(links, a, b, "messaged");
    return links === state.links ? state : { links };
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
    for (const link of seeded) for (const relation of link.relations) links = addLink(links, sessionId, link.sessionId, relation);
    return links === state.links ? state : { links };
  }),
}));
