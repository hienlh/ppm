/**
 * History compaction: past 90 days only the key events remain (created, status moves, closed,
 * reopened). Everything else older is deleted; by then it can no longer be undone either. A key
 * event that was undone goes too once its undo is past the window — the undo row itself is not a
 * key event, and the pair left half would show a status move that no longer happened.
 */
import { getDb } from "../db.service.ts";
import { HISTORY_DETAIL_DAYS, KEY_HISTORY_KINDS } from "../../shared/ppm-tasks.ts";

const DAY = 86_400_000;

/** Deletes detail rows older than the window; returns how many went. */
export function compactHistory(now: number = Date.now()): number {
  const cutoff = now - HISTORY_DETAIL_DAYS * DAY;
  const result = getDb().query(
    `DELETE FROM task_history WHERE at < ? AND (kind NOT IN (${KEY_HISTORY_KINDS.map(() => "?").join(",")})
       OR undone_by IN (SELECT id FROM task_history WHERE at < ?))`,
  ).run(cutoff, ...KEY_HISTORY_KINDS, cutoff);
  return result.changes;
}
