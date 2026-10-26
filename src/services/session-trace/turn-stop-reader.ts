import { getTraceDb } from "./session-trace-db.ts";
import { resolveTraceId } from "./session-trace-store.ts";
import type { TurnStop } from "../../shared/turn-stop.ts";

/**
 * The rows that say where a session's turns stand, newest first. A subagent's own rows carry
 * `parentToolUseId` and are left out: one still streaming after its turn ended says nothing
 * about how the turn ended. `tool_result` is left out as well — it always follows a `tool_use`,
 * and it is the one row that can weigh a megabyte.
 */
const ROWS_SQL = `
  SELECT type, ts,
    CASE WHEN type IN ('error', 'run_failed') THEN json_extract(payload_json, '$.message') END AS message,
    CASE WHEN type = 'done' THEN json_extract(payload_json, '$.resultSubtype') END AS subtype,
    CASE WHEN type = 'turn_aborted' THEN json_extract(payload_json, '$.reason') END AS reason
  FROM session_events
  WHERE trace_id = ?
    AND type IN ('user_message', 'done', 'run_failed', 'turn_aborted', 'error', 'text', 'thinking', 'tool_use')
    AND json_extract(payload_json, '$.parentToolUseId') IS NULL
  ORDER BY seq DESC
  LIMIT 64`;

export interface TurnStopRow {
  type: string;
  ts: number;
  message: string | null;
  subtype: string | null;
  /** Why PPM stopped the run, on a `turn_aborted` row (`ws_cancel` is the user's Stop). */
  reason?: string | null;
}

/**
 * How the session's last turn ended, when an error ended it — read from the trace, because
 * nothing else keeps it: the transcript has no record of the stop, and the chat socket's
 * session entry is dropped once nobody has watched for a while, which is exactly when someone
 * coming back needs to be told. Null for a session with no trace.
 */
export function readLastTurnStop(sessionId: string): TurnStop | null {
  const rows = getTraceDb().query(ROWS_SQL).all(resolveTraceId(sessionId)) as TurnStopRow[];
  return lastTurnStop(rows);
}

/**
 * The decision, given `ROWS_SQL`'s rows newest first. A stop is an error with nothing the
 * model produced after it, in a turn nobody stopped on purpose and nobody has written to since.
 */
export function lastTurnStop(rows: readonly TurnStopRow[]): TurnStop | null {
  let end: TurnStopRow | null = null;
  let stop: TurnStop | null = null;
  for (const row of rows) {
    if (!end) {
      // Written after the turn was over: an idle subprocess released, or a model switch.
      if (row.type === "turn_aborted") continue;
      // A newer message, or a turn still producing.
      if (row.type !== "done" && row.type !== "run_failed" && row.type !== "error") return null;
      end = row;
      // The run threw, or an error came with no `done` after it.
      if (row.type !== "done") stop = { message: row.message || "The turn ended with an error.", at: row.ts };
      continue;
    }
    // Walking back through the turn `end` closed, to its first row.
    if (row.type === "turn_aborted") return null; // stopped on purpose, by the user or by PPM
    if (row.type === "user_message" || row.type === "done") break;
    if (stop) continue; // only an abort can still change the answer
    if (row.type !== "error") return null; // the turn's last word was the model's, not an error
    stop = {
      message: row.message || "The turn ended with an error.",
      ...(end.subtype ? { subtype: end.subtype } : {}),
      at: end.ts,
    };
  }
  return stop;
}

/** The user's Stop button, as `chatService.abortQuery` records it. Other abort reasons are PPM's own. */
const USER_CANCEL_REASON = "ws_cancel";

/**
 * How the latest turn ended, from the trace alone. `unfinished` is a turn whose rows stop
 * mid-turn: running if the session is live, else a run that died without a word, which only
 * the caller can tell apart.
 */
export type TraceTurnOutcome =
  | { outcome: "done"; at: number }
  | { outcome: "cancelled"; at: number }
  | { outcome: "error" | "max_turns"; at: number; message: string; subtype?: string }
  | { outcome: "unfinished"; at: number };

export interface TraceTurnStatus {
  last: TraceTurnOutcome | null;
  /** Newest top-level `done`; null when the window of rows read holds none. */
  lastAnswerAt: number | null;
  lastUserMessageAt: number | null;
}

/**
 * The outcome of the latest turn, given `ROWS_SQL`'s rows newest first. A user cancel is told
 * apart from `lastTurnStop`'s "stopped on purpose": the Stop button's abort inside the turn,
 * before the turn finished. An abort written after the turn's own `done` (Stop pressed just
 * too late) leaves the turn done.
 */
export function lastTurnOutcome(rows: readonly TurnStopRow[]): TraceTurnOutcome | null {
  if (rows.length === 0) return null;
  const boundary = rows.findIndex((r) => r.type === "user_message");
  const turn = boundary === -1 ? rows : rows.slice(0, boundary);

  const cancelAt = turn.findIndex((r) => r.type === "turn_aborted" && r.reason === USER_CANCEL_REASON);
  if (cancelAt !== -1) {
    const quietSince = turn.slice(0, cancelAt)
      .every((r) => r.type === "done" || r.type === "error" || r.type === "run_failed" || r.type === "turn_aborted");
    const finishedBefore = turn.slice(cancelAt + 1).some((r) => r.type === "done");
    if (quietSince && !finishedBefore) return { outcome: "cancelled", at: turn[cancelAt]!.ts };
  }

  const stop = lastTurnStop(rows);
  if (stop) {
    return {
      outcome: stop.subtype === "error_max_turns" ? "max_turns" : "error",
      at: stop.at,
      message: stop.message,
      ...(stop.subtype ? { subtype: stop.subtype } : {}),
    };
  }

  const newest = rows.find((r) => r.type !== "turn_aborted");
  if (newest?.type === "done") return { outcome: "done", at: newest.ts };
  return { outcome: "unfinished", at: (newest ?? rows[0]!).ts };
}

/** {@link lastTurnOutcome} plus the latest answer and user message, for one trace id. */
export function readTurnStatusForTrace(traceId: string): TraceTurnStatus {
  const rows = getTraceDb().query(ROWS_SQL).all(traceId) as TurnStopRow[];
  return {
    last: lastTurnOutcome(rows),
    lastAnswerAt: rows.find((r) => r.type === "done")?.ts ?? null,
    lastUserMessageAt: rows.find((r) => r.type === "user_message")?.ts ?? null,
  };
}

/** {@link readTurnStatusForTrace} for a session id, resolved past any id the provider migrated to. */
export function readTurnStatus(sessionId: string): TraceTurnStatus {
  return readTurnStatusForTrace(resolveTraceId(sessionId));
}
