/**
 * Bookmarked turns of a chat: a place to come back to, kept per session in `ppm.db` so every
 * device sees the same list. Keyed by turn id, the one name of a place in a chat that survives a
 * reload, a compaction and a history window (a Codex message id is a position, not an identity).
 *
 * Its own table, created on first use rather than by a migration, for the same reason as
 * `session-archive.service.ts`: nothing references it, and a numbered migration would collide.
 */
import { getDb } from "./db.service.ts";
import type { SessionBookmark } from "../shared/session-bookmarks.ts";

/** Most bookmarks one chat keeps; the oldest goes when a new one would pass it. */
export const MAX_BOOKMARKS_PER_SESSION = 200;

let ensured: unknown = null;
function db() {
  const d = getDb();
  if (ensured !== d) {
    d.exec("CREATE TABLE IF NOT EXISTS session_bookmarks (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, turn_n INTEGER, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (session_id, turn_id))");
    ensured = d;
  }
  return d;
}

interface Row { turn_id: string; turn_n: number | null; label: string; created_at: string }

/** The chat's bookmarks, in turn order (unnumbered ones last, by when they were made). */
export function listSessionBookmarks(sessionId: string): SessionBookmark[] {
  const rows = db().query("SELECT turn_id, turn_n, label, created_at FROM session_bookmarks WHERE session_id = ? ORDER BY turn_n IS NULL, turn_n, created_at").all(sessionId) as Row[];
  return rows.map((r) => ({ turnId: r.turn_id, ...(r.turn_n != null && { turnN: r.turn_n }), label: r.label, createdAt: r.created_at }));
}

/** Bookmark a turn, or update the label of one already bookmarked. */
export function addSessionBookmark(sessionId: string, b: { turnId: string; turnN?: number; label: string }): SessionBookmark[] {
  const d = db();
  d.query(
    "INSERT INTO session_bookmarks (session_id, turn_id, turn_n, label, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, turn_id) DO UPDATE SET label = excluded.label, turn_n = COALESCE(excluded.turn_n, turn_n)",
  ).run(sessionId, b.turnId, b.turnN ?? null, b.label, new Date().toISOString());
  d.query(
    "DELETE FROM session_bookmarks WHERE session_id = ? AND turn_id NOT IN (SELECT turn_id FROM session_bookmarks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?)",
  ).run(sessionId, sessionId, MAX_BOOKMARKS_PER_SESSION);
  return listSessionBookmarks(sessionId);
}

export function removeSessionBookmark(sessionId: string, turnId: string): SessionBookmark[] {
  db().query("DELETE FROM session_bookmarks WHERE session_id = ? AND turn_id = ?").run(sessionId, turnId);
  return listSessionBookmarks(sessionId);
}
