/**
 * Who created each session of a session-list page, read in two queries for the whole page: the
 * `spawned_by` column, and the creators' titles. Read-only; the list route adds both to its rows so
 * an AI-created session can be marked without a request per row.
 */
import { getDb, getSessionTitles, resolveMigratedSession } from "../db.service.ts";

export interface SessionSpawnLink {
  spawnedBy: string;
  parentTitle: string | null;
}

/** Chunked well under SQLite's bound-parameter limit, which a long history page can reach. */
const CHUNK = 500;

/** sessionId → its creator and the creator's title, for the ids an AI created. */
export function sessionSpawnLinks(sessionIds: readonly string[]): Record<string, SessionSpawnLink> {
  const parents: Record<string, string> = {};
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const rows = getDb().query(
      `SELECT session_id, spawned_by FROM session_metadata WHERE spawned_by IS NOT NULL AND session_id IN (${chunk.map(() => "?").join(", ")})`,
    ).all(...chunk) as Array<{ session_id: string; spawned_by: string }>;
    // A creator renamed since (a Codex chat adopting its thread id) is named by its current id.
    for (const r of rows) parents[r.session_id] = resolveMigratedSession(r.spawned_by);
  }
  const parentIds = [...new Set(Object.values(parents))];
  const titles: Record<string, string> = {};
  for (let i = 0; i < parentIds.length; i += CHUNK) Object.assign(titles, getSessionTitles(parentIds.slice(i, i + CHUNK)));
  const out: Record<string, SessionSpawnLink> = {};
  for (const [id, parent] of Object.entries(parents)) out[id] = { spawnedBy: parent, parentTitle: titles[parent] ?? null };
  return out;
}
