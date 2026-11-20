/**
 * Archived chats: kept on disk and in search, left out of the history list unless its filter asks
 * for them (Claude Code desktop's archive). A chat is archived by hand, or — when the device's
 * "Auto-archive after N days" is on — once it has been idle that long; un-archiving an auto-archived
 * chat marks it `kept`, so the rule leaves it alone from then on.
 *
 * Its own table, created on first use rather than by a migration: nothing else references it, and
 * a numbered migration here would collide with the numbering other branches carry.
 */
import { getDb } from "./db.service.ts";

export type SessionArchiveState = "archived" | "kept";

let ensured: unknown = null;
function db() {
  const d = getDb();
  if (ensured !== d) {
    d.exec("CREATE TABLE IF NOT EXISTS session_archive (session_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('archived','kept')), changed_at TEXT NOT NULL DEFAULT (datetime('now')))");
    ensured = d;
  }
  return d;
}

export function setSessionArchiveState(sessionId: string, state: SessionArchiveState | null): void {
  if (state === null) {
    db().query("DELETE FROM session_archive WHERE session_id = ?").run(sessionId);
    return;
  }
  db().query(
    "INSERT INTO session_archive (session_id, state) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, changed_at = datetime('now')",
  ).run(sessionId, state);
}

/** Each listed session's state; a session with none is absent. */
export function getSessionArchiveStates(sessionIds: readonly string[]): Map<string, SessionArchiveState> {
  const out = new Map<string, SessionArchiveState>();
  if (sessionIds.length === 0) return out;
  const want = new Set(sessionIds);
  const rows = db().query("SELECT session_id, state FROM session_archive").all() as { session_id: string; state: SessionArchiveState }[];
  for (const r of rows) if (want.has(r.session_id)) out.set(r.session_id, r.state);
  return out;
}
