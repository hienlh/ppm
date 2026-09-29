/**
 * Pure list operations for the shared session store — sorting, pin
 * injection, dedupe, id replacement and the bulk-delete cutoff — kept out of
 * the zustand module so they can be unit tested without importing a store
 * that reads localStorage at module scope (which throws under bun:test).
 */
import { compareSessionsByActivity, type SessionInfo } from "../../types/chat";

export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(compareSessionsByActivity);
}

/** Drops every id after its first occurrence, keeping list order otherwise. */
export function dedupeById(sessions: SessionInfo[]): SessionInfo[] {
  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Insert or replace a session by id, then resort — used for both a locally
 * created/forked session and one a background sync fetched. */
export function upsertSession(sessions: SessionInfo[], session: SessionInfo): SessionInfo[] {
  const idx = sessions.findIndex((s) => s.id === session.id);
  const next = idx === -1
    ? [...sessions, session]
    : sessions.map((s, i) => (i === idx ? { ...s, ...session } : s));
  return sortSessions(next);
}

export function removeSession(sessions: SessionInfo[], id: string): SessionInfo[] {
  return sessions.filter((s) => s.id !== id);
}

export function renameSession(sessions: SessionInfo[], id: string, title: string): SessionInfo[] {
  return sessions.map((s) => (s.id === id ? { ...s, title } : s));
}

/** The provider adopted its own id for a session PPM minted — swap it in place
 * so history rows and every open tab keep pointing at the same row. If the
 * new id is somehow already present (a rare migrate-twice race), the stale
 * row under the old id is dropped rather than showing the same chat twice. */
export function replaceSessionId(sessions: SessionInfo[], oldId: string, newId: string): SessionInfo[] {
  if (oldId === newId) return sessions;
  const hasNew = sessions.some((s) => s.id === newId);
  const base = hasNew ? sessions.filter((s) => s.id !== oldId) : sessions;
  return base.map((s) => (s.id === oldId ? { ...s, id: newId } : s));
}

export function setPinned(sessions: SessionInfo[], id: string, pinned: boolean): SessionInfo[] {
  return sortSessions(sessions.map((s) => (s.id === id ? { ...s, pinned } : s)));
}

export function setSessionTag(
  sessions: SessionInfo[],
  id: string,
  tag: { id: number; name: string; color: string } | null,
): SessionInfo[] {
  return sessions.map((s) => (s.id === id ? { ...s, tag } : s));
}

/** A deleted tag stops applying to any cached row that carried it — the
 * server already cleared it, so cached rows must not keep showing a chip for
 * a tag that no longer exists. */
export function clearDeletedTag(sessions: SessionInfo[], tagId: number): SessionInfo[] {
  return sessions.map((s) => (s.tag?.id === tagId ? { ...s, tag: null } : s));
}

function sessionActivityTime(session: SessionInfo): number {
  const updated = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(session.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/** An approximation of the server's bulk delete, applied to the cached rows until the
 * re-sync that follows it lands: pinned rows survive, everything else is dropped once its
 * last activity is older than `days`. The server's rule is narrower — it goes by
 * `createdAt`, lists only the default provider's sessions and keeps any session that has
 * forks — so this can briefly hide a row the server kept; the re-sync brings it back. */
export function removeOlderThan(sessions: SessionInfo[], days: number, now: number = Date.now()): SessionInfo[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return sessions.filter((s) => s.pinned || sessionActivityTime(s) >= cutoff);
}
