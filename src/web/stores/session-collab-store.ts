/**
 * What `/ws/global` has said about sessions reaching each other since the page loaded: links that
 * appeared (a spawn, a first message between two sessions), the sessions' titles and providers as
 * announced, and which sessions hold a create, pair-limit or escalation card right now.
 *
 * Only the live layer. What is already on disk reaches the browser through the session list's
 * `spawnedBy` and the chat's own messages; `use-linked-sessions.ts` merges the three.
 */
import { create } from "zustand";
import type {
  SessionCollabApprovalEvent, SessionCreatedEvent, SessionLinkChangedEvent, SessionLinkRelation,
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
    announced: { ...state.announced, [event.sessionId]: { title: event.title, providerId: event.providerId, projectName: event.projectName } },
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
}));
