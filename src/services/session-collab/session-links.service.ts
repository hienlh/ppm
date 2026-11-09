/**
 * Who created whom among a project's sessions, and which sessions are linked to one another.
 *
 * A spawn is two columns of `session_metadata`: `spawned_by` (the creating session) and
 * `spawn_depth` (0 for a session a person started). Every id is canonical on the way in and on
 * the way out — a Codex chat is renamed during its first turn, `setSessionMigratedTo` carries both
 * columns to the new id, and a child recorded under its parent's old id is still found.
 */
import { getDb, resolveMigratedSession, sessionIdAliases } from "../db.service.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";
import type { SessionLink, SessionLinkRelation } from "../../shared/session-collab.ts";
import { pairCounter } from "./pair-counter.ts";

/** How far `recordSpawn` walks up looking for a cycle; deeper than any allowed chain. */
const MAX_ANCESTRY = 32;

function requireId(id: string): string {
  const canonical = resolveMigratedSession(id);
  if (!SESSION_ID_RE.test(canonical)) throw new Error(`Invalid session id: ${id}`);
  return canonical;
}

/** The session that created this one, or null when a person did. */
export function parentOf(sessionId: string): string | null {
  const row = getDb().query("SELECT spawned_by FROM session_metadata WHERE session_id = ?")
    .get(resolveMigratedSession(sessionId)) as { spawned_by: string | null } | null;
  return row?.spawned_by ? resolveMigratedSession(row.spawned_by) : null;
}

/** 0 for a session a person started; a created session is its creator's depth + 1. */
export function depthOf(sessionId: string): number {
  const row = getDb().query("SELECT spawn_depth FROM session_metadata WHERE session_id = ?")
    .get(resolveMigratedSession(sessionId)) as { spawn_depth: number | null } | null;
  return row?.spawn_depth ?? 0;
}

/**
 * Records that `parentId`'s AI created `childId`, at the parent's depth + 1, and returns that
 * depth. Refuses a session creating itself or one of its own ancestors.
 */
export function recordSpawn(childId: string, parentId: string): number {
  const child = requireId(childId);
  const parent = requireId(parentId);
  if (child === parent) throw new Error("A session cannot create itself");
  let ancestor: string | null = parent;
  for (let i = 0; ancestor && i < MAX_ANCESTRY; i++) {
    if (ancestor === child) throw new Error("A session cannot be created by one of its own descendants");
    ancestor = parentOf(ancestor);
  }
  const depth = depthOf(parent) + 1;
  getDb().query(
    "INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES (?, ?, ?) "
    + "ON CONFLICT(session_id) DO UPDATE SET spawned_by = excluded.spawned_by, spawn_depth = excluded.spawn_depth",
  ).run(child, parent, depth);
  return depth;
}

/** The sessions this one created, by canonical id. */
export function childrenOf(sessionId: string): string[] {
  const aliases = sessionIdAliases(sessionId);
  const rows = getDb().query(
    `SELECT session_id FROM session_metadata WHERE migrated_to IS NULL AND spawned_by IN (${aliases.map(() => "?").join(", ")})`,
  ).all(...aliases) as Array<{ session_id: string }>;
  return [...new Set(rows.map((r) => resolveMigratedSession(r.session_id)))];
}

/** Whether an AI created this session. */
export const isSpawned = (sessionId: string): boolean => parentOf(sessionId) !== null;

/**
 * Every session linked to this one: its creator, the sessions it created, and the sessions it has
 * exchanged messages with, each once with every relation that applies.
 */
export function linkedSessions(sessionId: string): SessionLink[] {
  const self = resolveMigratedSession(sessionId);
  const byId = new Map<string, Set<SessionLinkRelation>>();
  const add = (id: string, relation: SessionLinkRelation) => {
    if (id === self) return;
    (byId.get(id) ?? byId.set(id, new Set()).get(id)!).add(relation);
  };
  const parent = parentOf(self);
  if (parent) add(parent, "parent");
  for (const child of childrenOf(self)) add(child, "child");
  for (const other of pairCounter.messagedWith(self)) add(other, "messaged");
  return [...byId].map(([id, relations]) => ({ sessionId: id, relations: [...relations] }));
}

/**
 * How many of `runningSessionIds` (sessions with a turn in flight, from the chat registry) an AI
 * created — what the "AI-created sessions running at once" limit counts.
 */
export function countSpawned(runningSessionIds: Iterable<string>): number {
  let n = 0;
  for (const id of runningSessionIds) if (isSpawned(id)) n++;
  return n;
}
