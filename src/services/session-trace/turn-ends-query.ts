import { getTraceDb } from "./session-trace-db.ts";
import { lastTurnStop, TURN_STOP_ROWS_SQL, type TurnStopRow } from "./turn-stop-reader.ts";
import { resolveMigratedSession } from "../db.service.ts";
import type { TurnStop } from "../../shared/turn-stop.ts";

/**
 * Which chats had a turn end since a moment, and how the last one ended — for "what finished
 * today, what stopped on an error", across every chat whether or not anyone has it open. Only
 * the trace knows this: a transcript does not record why a turn stopped, and the chat socket
 * forgets a session nobody watches.
 *
 * The range scan uses the trace's `ts` index; a subagent's own rows (they carry
 * `parentToolUseId`) say nothing about how the turn ended and are left out.
 */

const ENDS_SQL = `
  SELECT trace_id, MAX(ts) AS ended_at, provider_id
  FROM session_events
  WHERE ts >= ?
    AND type IN ('done', 'run_failed', 'error')
    AND json_extract(payload_json, '$.parentToolUseId') IS NULL
  GROUP BY trace_id
  ORDER BY ended_at DESC
  LIMIT ?`;

export interface TurnEnd {
  /** The id the session goes by now (a Codex chat is renamed on its first turn). */
  sessionId: string;
  /** The id the trace was started under. */
  traceId: string;
  providerId: string | null;
  /** When the newest turn-ending row was written. */
  endedAt: number;
  /** Present when an error ended the last turn and nothing came after it. */
  stop?: TurnStop;
}

/** Most chats one call looks at; past this the oldest are left out (the newest come first). */
export const MAX_TURN_ENDS = 500;

/** Every chat whose turn ended at or after `sinceMs`, newest first. Throws when the trace cannot be read. */
export function turnEndsSince(sinceMs: number, limit = MAX_TURN_ENDS): TurnEnd[] {
  const db = getTraceDb();
  const rows = db.query(ENDS_SQL).all(sinceMs, Math.max(1, Math.min(limit, MAX_TURN_ENDS))) as Array<{
    trace_id: string; ended_at: number; provider_id: string | null;
  }>;
  // A trace found here is already a trace id: no alias lookup before reading its last turn.
  const lastTurn = db.query(TURN_STOP_ROWS_SQL);
  return rows.map((r) => {
    const stop = lastTurnStop(lastTurn.all(r.trace_id) as TurnStopRow[]);
    return {
      sessionId: resolveMigratedSession(r.trace_id),
      traceId: r.trace_id,
      providerId: r.provider_id,
      endedAt: r.ended_at,
      ...(stop ? { stop } : {}),
    };
  });
}
