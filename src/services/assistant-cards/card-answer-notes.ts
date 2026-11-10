/**
 * Silent news for the main PPM Assistant session: the cards the user answered themselves since its
 * last turn (an OK, or their own words forwarded to a manager chat). Nothing starts a turn for it;
 * the entry rides on the session's next turn, whoever starts it, so the Assistant does not ask a
 * manager about something the user already settled. Every line is PPM's own wording: the user's
 * text and the card's title (a manager AI's words) are never repeated here.
 *
 * Kept in memory: after a restart the cards themselves still say who answered them.
 */
import { resolveMigratedSession } from "../db.service.ts";

const MAX_NOTES = 30;
const notes = new Map<string, string[]>();

/** One line of news for `assistantSessionId`'s next turn. */
export function noteCardAnswered(assistantSessionId: string, line: string): void {
  const id = resolveMigratedSession(assistantSessionId);
  const list = notes.get(id) ?? [];
  list.push(line);
  notes.set(id, list.slice(-MAX_NOTES));
}

/** The shared-context entry for this session's turn, once; undefined when there is no news. */
export function takeCardAnswerNotes(sessionId: string): string | undefined {
  const id = resolveMigratedSession(sessionId);
  const list = notes.get(id);
  if (!list?.length) return undefined;
  notes.delete(id);
  return ["Cards the user answered themselves since your last turn (written by PPM; nothing to do unless asked):", ...list.map((l) => `- ${l}`)].join("\n");
}

/** For tests. */
export function _clearCardAnswerNotes(): void {
  notes.clear();
}
