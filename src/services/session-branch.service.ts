import { getDb } from "./db.service.ts";
import type { VersionGroup } from "../types/api.ts";

/**
 * How a branch came to exist. `edit` is an alternate version of the same
 * conversation, reachable through the in-message version switcher. `fork` is a
 * deliberate new thread opened in its own tab. Only `edit` nodes collapse in the
 * history list; a fork stays a first-class conversation there.
 */
export type BranchKind = "edit" | "fork";

/** A node in the edit-message branch tree (one forked session). */
export interface BranchRow {
  child_id: string;
  parent_id: string;
  fork_msg_id: string;
  /** User-message ordinal (1-based) of the divergent message — stable across forks. */
  fork_ordinal: number;
  root_id: string;
  /** Null on rows written before the kind column existed; treated as `fork`. */
  kind: BranchKind | null;
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
export function recordBranch(
  childId: string,
  parentId: string,
  forkMsgId: string,
  forkOrdinal: number,
  kind: BranchKind = "edit",
): void {
  const parentRoot = getRootId(parentId);
  const rootId = parentRoot ?? parentId;
  getDb().run(
    `INSERT OR REPLACE INTO session_branches (child_id, parent_id, fork_msg_id, fork_ordinal, root_id, kind)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [childId, parentId, forkMsgId, forkOrdinal, rootId, kind],
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

export type { VersionGroup } from "../types/api.ts";

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

/**
 * Every version group in `sessionId`'s tree, keyed by user-message ordinal.
 *
 * Same answer as calling resolveVersionGroup() for each ordinal, but with two
 * queries instead of an ancestor walk per ordinal (one getBranchRow per hop).
 * The switcher renders on every user message, so the per-ordinal path cost one
 * request and up to 100 sequential queries per rendered message.
 *
 * An ordinal absent from the result means "no versions here" — the caller hides
 * the switcher. Only ordinals that some node actually forked at can appear, so
 * the map holds one entry per edited message.
 */
export function resolveVersionMap(sessionId: string): Record<number, VersionGroup> {
  const ownRow = getBranchRow(sessionId);
  const rootId = ownRow?.root_id ?? sessionId;
  const tree = getTreeByRoot(rootId);
  if (tree.length === 0) return {};

  const byChild = new Map<string, BranchRow>();
  const siblings = new Map<string, BranchRow[]>();
  for (const row of tree) {
    byChild.set(row.child_id, row);
    const key = `${row.parent_id}:${row.fork_ordinal}`;
    const list = siblings.get(key);
    if (list) list.push(row);
    else siblings.set(key, [row]);
  }

  const map: Record<number, VersionGroup> = {};
  // Rows written before fork_ordinal existed have it NULL. SQL `= NULL` never
  // matches, so the per-ordinal path silently ignores them; skip them here too
  // instead of emitting a bogus `null` key into the response.
  for (const ordinal of new Set(tree.map((r) => r.fork_ordinal))) {
    if (!Number.isInteger(ordinal)) continue;
    // Mirror resolveVersionGroup: climb while the queried message still lies in
    // the inherited prefix, so a deep leaf keeps showing its ancestor's group.
    let current = sessionId;
    let row = byChild.get(current);
    for (let hops = 0; row && ordinal < row.fork_ordinal && hops < 100; hops++) {
      current = row.parent_id;
      row = byChild.get(current);
    }
    const parentId = row && row.fork_ordinal === ordinal ? row.parent_id : current;
    const children = siblings.get(`${parentId}:${ordinal}`);
    if (!children || children.length === 0) continue;
    const ids = [parentId, ...children.map((c) => c.child_id)];
    const idx = ids.indexOf(current);
    map[ordinal] = { ids, currentIndex: idx < 0 ? 0 : idx };
  }
  return map;
}

/** Minimal shape needed to collapse a session list into per-tree heads. */
export interface GroupableSession {
  id: string;
  createdAt: string;
  updatedAt?: string;
  pinned?: boolean;
}

/**
 * Session whose history row this one folds into: climb while every hop is a
 * message edit, and stop at the first explicit fork. A fork therefore anchors
 * its own group, so it never displaces — or gets displaced by — the thread it
 * was forked from. An unclassified (pre-`kind`) row stops the climb too, which
 * errs toward showing a row rather than hiding a conversation.
 */
export function getCollapseGroupId(sessionId: string): string {
  let current = sessionId;
  for (let hops = 0; hops < 100; hops++) {
    const row = getBranchRow(current);
    if (!row || row.kind !== "edit") return current;
    current = row.parent_id;
  }
  return current;
}

/**
 * Collapse each edit-version group to a single row — its head, the most recently
 * active node (max updatedAt, falling back to createdAt). Pinned sessions are
 * passed through untouched. Caller is responsible for final sort.
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
    const groupId = getCollapseGroupId(s.id);
    const cur = heads.get(groupId);
    if (!cur || activity(s) > activity(cur)) heads.set(groupId, s);
  }
  out.push(...heads.values());
  return out;
}
