import { getTraceDb } from "../session-trace/session-trace-db.ts";
import { resolveTraceId } from "../session-trace/session-trace-store.ts";
import { lastTurnStop, TURN_STOP_ROWS_SQL, type TurnStopRow } from "../session-trace/turn-stop-reader.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";

/**
 * Whether a chat's last turn ended at or after a moment, and how — from the session trace,
 * which outlives both the process and the chat socket's memory of the session. Used where no
 * live `turn_ended` can be heard: at start-up, for a watch whose chat was running when PPM
 * stopped, and when a watch is asked for a chat that may already have finished.
 */
export interface TraceTurnEnd {
  kind: "done" | "stopped";
  at: number;
  /** For `stopped`: what stopped it, as the chat's stop bar words it. */
  stopReason?: string;
}

/** Rows written after a turn was over (an idle process released, a model switch). */
const AFTER_TURN = "turn_aborted";
const TURN_ENDS = new Set(["done", "run_failed", "error"]);

/**
 * How the chat's newest turn ended, if it ended at or after `sinceMs`; null when it is still
 * going (or was cut off mid-way, which is what a restart does to a running turn) or ended earlier.
 */
export function readTurnEndSince(sessionId: string, sinceMs: number): TraceTurnEnd | null {
  const rows = getTraceDb().query(TURN_STOP_ROWS_SQL).all(resolveTraceId(sessionId)) as TurnStopRow[];
  const newest = rows.find((r) => r.type !== AFTER_TURN);
  if (!newest || !TURN_ENDS.has(newest.type) || newest.ts < sinceMs) return null;
  const stop = lastTurnStop(rows);
  if (!stop) return { kind: "done", at: newest.ts };
  const { title, detail } = describeTurnStop(stop);
  return { kind: "stopped", at: newest.ts, stopReason: [title, detail].filter(Boolean).join(" — ") };
}
