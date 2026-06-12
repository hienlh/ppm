import { getDb } from "./db.service.ts";

/** A node in the edit-message branch tree (one forked session). */
export interface BranchRow {
  child_id: string;
  parent_id: string;
  fork_msg_id: string;
  /** User-message ordinal (1-based) of the divergent message — stable across forks. */
  fork_ordinal: number;
  root_id: string;
  created_at: string;
}

/**
 * Record a fork relationship. root_id is inherited from the parent's row when
 * the parent is itself a forked node; otherwise the parent is a tree root and
 * becomes the root_id. `forkOrdinal` is the user-message ordinal of the edited
 * message — the stable anchor (forkSession reassigns message UUIDs, so the
 * parent-space fork_msg_id can't be matched against the child's transcript).
 * Idempotent on child_id (INSERT OR REPLACE).
 */
export function recordBranch(childId: string, parentId: string, forkMsgId: string, forkOrdinal: number): void {
  const parentRoot = getRootId(parentId);
  const rootId = parentRoot ?? parentId;
  getDb().run(
    `INSERT OR REPLACE INTO session_branches (child_id, parent_id, fork_msg_id, fork_ordinal, root_id)
     VALUES (?, ?, ?, ?, ?)`,
    [childId, parentId, forkMsgId, forkOrdinal, rootId],
  );
}

/** Root of the tree this session belongs to, or null if it has no branch row. */
export function getRootId(sessionId: string): string | null {
  const row = getDb()
    .query("SELECT root_id FROM session_branches WHERE child_id = ?")
    .get(sessionId) as { root_id: string } | null;
  return row?.root_id ?? null;
}

/** Children forked from `parentId` at user-ordinal `forkOrdinal`, ordered oldest-first. */
export function getSiblingsByOrdinal(parentId: string, forkOrdinal: number): BranchRow[] {
  return getDb()
    .query(
      `SELECT * FROM session_branches
       WHERE parent_id = ? AND fork_ordinal = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(parentId, forkOrdinal) as BranchRow[];
}

/** Every node sharing the given root (the whole tree, excluding the root itself). */
export function getTreeByRoot(rootId: string): BranchRow[] {
  return getDb()
    .query("SELECT * FROM session_branches WHERE root_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(rootId) as BranchRow[];
}

/** The branch row for this session (null if it is a tree root / not forked). */
export function getBranchRow(sessionId: string): BranchRow | null {
  return (
    (getDb()
      .query("SELECT * FROM session_branches WHERE child_id = ?")
      .get(sessionId) as BranchRow | null) ?? null
  );
}

/** True if any branch was forked from this session (i.e. it is not a leaf). */
export function hasChildren(sessionId: string): boolean {
  const row = getDb()
    .query("SELECT COUNT(*) AS n FROM session_branches WHERE parent_id = ?")
    .get(sessionId) as { n: number };
  return row.n > 0;
}

/** Remove the branch row for a deleted session. */
export function deleteBranchesFor(sessionId: string): void {
  getDb().run("DELETE FROM session_branches WHERE child_id = ?", [sessionId]);
}

export interface VersionGroup {
  /** Ordered version session ids: parent (v1 / original) first, then children oldest-first. */
  ids: string[];
  /** Position of the queried session within `ids`. */
  currentIndex: number;
}

/**
 * Resolve the sibling versions of the user message at user-ordinal `ordinal`.
 * Works whether `sessionId` is the original (parent) or one of the edited
 * children. Ordinal is stable across forks (the copied prefix is identical),
 * unlike message UUIDs which forkSession reassigns. Returns null when no fork
 * exists at this ordinal (FE then hides the switcher).
 */
export function resolveVersionGroup(sessionId: string, ordinal: number): VersionGroup | null {
  // Walk up the ancestor chain while the queried message lies in the INHERITED
  // prefix (ordinal < the node's own divergence ordinal). A grandchild's
  // transcript contains copies of every ancestor's pre-fork messages, so the
  // branch point for such a message belongs to the ancestor that diverged
  // there — this keeps the switcher visible on deep leaves of the tree.
  let current = sessionId;
  let row = getBranchRow(current);
  for (let hops = 0; row && ordinal < row.fork_ordinal && hops < 100; hops++) {
    current = row.parent_id;
    row = getBranchRow(current);
  }
  // If `current` was itself forked at this ordinal, its siblings live under its
  // parent; otherwise `current` IS the parent (original) of any group here.
  const parentId = row && row.fork_ordinal === ordinal ? row.parent_id : current;
  const children = getSiblingsByOrdinal(parentId, ordinal);
  if (children.length === 0) return null;
  const ids = [parentId, ...children.map((c) => c.child_id)];
  // Position by lineage: the viewed session counts as its ancestor in this group.
  const idx = ids.indexOf(current);
  return { ids, currentIndex: idx < 0 ? 0 : idx };
}

/** Minimal shape needed to collapse a session list into per-tree heads. */
export interface GroupableSession {
  id: string;
  createdAt: string;
  updatedAt?: string;
  pinned?: boolean;
}

/**
 * Collapse branch-tree members so each tree shows a single row — its head, the
 * most recently active node (max updatedAt, falling back to createdAt). Pinned
 * sessions are passed through untouched. Caller is responsible for final sort.
 */
export function collapseTreesToHeads<T extends GroupableSession>(sessions: T[]): T[] {
  const heads = new Map<string, T>();
  const out: T[] = [];
  const activity = (s: T) => new Date(s.updatedAt ?? s.createdAt).getTime();
  for (const s of sessions) {
    if (s.pinned) {
      out.push(s);
      continue;
    }
    const rootId = getRootId(s.id) ?? s.id;
    const cur = heads.get(rootId);
    if (!cur || activity(s) > activity(cur)) heads.set(rootId, s);
  }
  out.push(...heads.values());
  return out;
}
