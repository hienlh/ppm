import { getTraceDb } from "./session-trace-db.ts";
import type { TraceOrigin, TraceSource } from "../../shared/session-trace.ts";

/** One row as the writer hands it over. `seq` is not here: it is assigned at insert. */
export interface TraceRow {
  traceId: string;
  turnId: string | null;
  ts: number;
  source: TraceSource;
  origin: TraceOrigin;
  providerId: string | null;
  refId: string | null;
  type: string;
  payloadJson: string;
}

/** One row as read back. */
export interface TraceEvent {
  traceId: string;
  seq: number;
  turnId: string | null;
  ts: number;
  source: TraceSource;
  origin: TraceOrigin;
  providerId: string | null;
  refId: string | null;
  type: string;
  payload: unknown;
}

interface DbRow {
  trace_id: string;
  seq: number;
  turn_id: string | null;
  ts: number;
  source: TraceSource;
  origin: TraceOrigin;
  provider_id: string | null;
  ref_id: string | null;
  type: string;
  payload_json: string;
}

// One statement, so the MAX and the insert cannot be split by another writer; the batch
// runs under BEGIN IMMEDIATE, so the server and a CLI appending to one trace take turns.
const INSERT_SQL = `
  INSERT INTO session_events (trace_id, seq, turn_id, ts, source, origin, provider_id, ref_id, type, payload_json)
  SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
  FROM session_events WHERE trace_id = ?1`;

/** Append rows in one transaction. Throws on failure — the writer decides to drop. */
export function appendBatch(rows: readonly TraceRow[]): void {
  if (rows.length === 0) return;
  const db = getTraceDb();
  const insert = db.query(INSERT_SQL);
  db.transaction((batch: readonly TraceRow[]) => {
    for (const r of batch) {
      insert.run(r.traceId, r.turnId, r.ts, r.source, r.origin, r.providerId, r.refId, r.type, r.payloadJson);
    }
  }).immediate(rows);
}

function toEvent(row: DbRow): TraceEvent {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { payload = row.payload_json; }
  return {
    traceId: row.trace_id,
    seq: row.seq,
    turnId: row.turn_id,
    ts: row.ts,
    source: row.source,
    origin: row.origin,
    providerId: row.provider_id,
    refId: row.ref_id,
    type: row.type,
    payload,
  };
}

/** Every row of one trace, in the order it was written. */
export function readEvents(traceId: string): TraceEvent[] {
  const rows = getTraceDb()
    .query("SELECT * FROM session_events WHERE trace_id = ? ORDER BY seq")
    .all(traceId) as DbRow[];
  return rows.map(toEvent);
}

/**
 * The trace a session id belongs to: itself, unless a provider renamed the session
 * mid-run (`session_migrated`), in which case the id the run started under.
 */
export function resolveTraceId(sessionId: string): string {
  const row = getTraceDb()
    .query("SELECT trace_id FROM trace_aliases WHERE alias_id = ?")
    .get(sessionId) as { trace_id: string } | null;
  return row?.trace_id ?? sessionId;
}

/** Record that `aliasId` now names the conversation traced under `traceId`. */
export function recordTraceAlias(aliasId: string, traceId: string): void {
  const root = resolveTraceId(traceId);
  if (aliasId === root) return;
  getTraceDb()
    .query("INSERT OR IGNORE INTO trace_aliases (alias_id, trace_id, ts) VALUES (?, ?, ?)")
    .run(aliasId, root, Date.now());
}

/**
 * A session's whole story: its own trace plus every browser row filed against it, under
 * any id the session has had. Browser rows carry `ref_id`, so this is the one query that
 * answers "which turn was running when the tab broke".
 */
export function readSessionTimeline(sessionId: string, limit = 5000): TraceEvent[] {
  const db = getTraceDb();
  const traceId = resolveTraceId(sessionId);
  const aliases = (db.query("SELECT alias_id FROM trace_aliases WHERE trace_id = ?").all(traceId) as { alias_id: string }[])
    .map((r) => r.alias_id);
  const ids = [traceId, ...aliases];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT * FROM (
      SELECT * FROM session_events
      WHERE trace_id = ? OR ref_id IN (${placeholders})
      ORDER BY ts DESC, seq DESC LIMIT ?
    ) ORDER BY ts, seq`)
    .all(traceId, ...ids, Math.max(1, Math.floor(limit))) as DbRow[];
  return rows.map(toEvent);
}

export function countTraceEvents(): number {
  return (getTraceDb().query("SELECT COUNT(*) AS count FROM session_events").get() as { count: number }).count;
}
