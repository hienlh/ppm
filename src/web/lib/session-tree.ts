/**
 * Folds a session list into a family tree: a session another session's AI created (a Spec task
 * chat, a chat opened through `create_session`) sits under its creator instead of beside it, so a
 * Run all that opens eighteen task chats adds one row to the history, not nineteen.
 *
 * Pure and order-preserving: the list arrives sorted (pinned first, then by activity) and every
 * family takes the place of its most recently active member, so a spec whose tasks are still
 * running stays at the top even though its own chat went quiet an hour ago.
 */
import type { SessionInfo } from "../../types/chat";

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

/**
 * One top-level row. `session` is null when the creator is not in the list (on a later page, or
 * filtered out by a tag): the row then stands for that creator, named by the children's
 * `parentTitle`, so its children still sit together rather than scattering through the list.
 */
export interface SessionTreeRoot {
  id: string;
  session: SessionInfo | null;
  parentTitle: string | null;
  children: SessionTreeNode[];
}

export function buildSessionTree(sessions: readonly SessionInfo[]): SessionTreeRoot[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const nodes = new Map(sessions.map((s) => [s.id, { session: s, children: [] as SessionTreeNode[] }]));
  const missingParents = new Map<string, SessionTreeRoot>();
  /** Top-level entries keyed by the list index of their most recently active member. */
  const firstIndex = new Map<SessionTreeRoot, number>();
  const rootOf = new Map<string, SessionTreeRoot>();

  // A pinned session was asked to stay visible on its own; a chain that loops back (it cannot,
  // but the data comes from a database) is cut where it would close.
  const parentIn = (s: SessionInfo): string | null => (s.pinned ? null : s.spawnedBy ?? null);
  const loopsBack = (s: SessionInfo): boolean => {
    const seen = new Set([s.id]);
    for (let p = parentIn(s); p && byId.has(p); p = parentIn(byId.get(p)!)) {
      if (seen.has(p)) return true;
      seen.add(p);
    }
    return false;
  };

  const topOf = (s: SessionInfo): SessionTreeRoot => {
    const cached = rootOf.get(s.id);
    if (cached) return cached;
    const parent = loopsBack(s) ? null : parentIn(s);
    let root: SessionTreeRoot;
    if (parent && byId.has(parent)) {
      root = topOf(byId.get(parent)!);
    } else if (parent) {
      root = missingParents.get(parent) ?? { id: parent, session: null, parentTitle: s.parentTitle ?? null, children: [] };
      missingParents.set(parent, root);
    } else {
      root = { id: s.id, session: s, parentTitle: null, children: nodes.get(s.id)!.children };
    }
    rootOf.set(s.id, root);
    return root;
  };

  sessions.forEach((s, i) => {
    const root = topOf(s);
    if (!firstIndex.has(root)) firstIndex.set(root, i);
    const parent = loopsBack(s) ? null : parentIn(s);
    if (!parent) return;
    const node = nodes.get(s.id)!;
    if (byId.has(parent)) nodes.get(parent)!.children.push(node);
    else root.children.push(node);
  });

  return [...firstIndex.entries()].sort((a, b) => a[1] - b[1]).map(([root]) => root);
}

/** Every session under a node, at any depth. */
export function descendantsOf(children: readonly SessionTreeNode[]): SessionInfo[] {
  const out: SessionInfo[] = [];
  const walk = (list: readonly SessionTreeNode[]) => {
    for (const n of list) { out.push(n.session); walk(n.children); }
  };
  walk(children);
  return out;
}
