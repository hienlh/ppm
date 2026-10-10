import { getDb, resolveMigratedSession } from "../db.service.ts";

/**
 * The name a watched chat is announced by — on a relayed card, in a report, in the watch list.
 *
 * The same lookup `chats_attention` makes (the title given to the chat, else the one PPM last saw
 * for it), so one chat does not go by different names on different surfaces. It also walks the
 * ids the chat had before a provider renamed it: Codex replaces a new chat's id during its first
 * turn, and a title stored under the first id (`chat_start` stores the approved one at once) would
 * otherwise be lost to the watch, which only ever sees the new id — and a report naming
 * "Session 01a127b8" for a chat the user knows as "List the root folder" reads as another chat's.
 */

/** How many renames are followed back; a real chat has one at most, this only bounds bad data. */
const MAX_IDS = 8;

export function watchedChatTitle(sessionId: string): string | null {
  const db = getDb();
  const earlier = db.query("SELECT session_id FROM session_metadata WHERE migrated_to = ?");
  // The current id first, then each earlier one: a title set after the rename wins.
  const ids = [resolveMigratedSession(sessionId)];
  for (let i = 0; i < ids.length && ids.length < MAX_IDS; i++) {
    for (const row of earlier.all(ids[i]!) as Array<{ session_id: string }>) {
      if (!ids.includes(row.session_id) && ids.length < MAX_IDS) ids.push(row.session_id);
    }
  }
  const given = db.query("SELECT title FROM session_titles WHERE session_id = ?");
  const seen = db.query("SELECT last_known_title AS title FROM session_metadata WHERE session_id = ?");
  for (const query of [given, seen]) {
    for (const id of ids) {
      const title = (query.get(id) as { title: string | null } | null)?.title?.trim();
      if (title) return title;
    }
  }
  return null;
}

/** What a chat is called when nothing names it. */
export const unnamedChat = (sessionId: string): string => `Session ${sessionId.slice(0, 8)}`;
