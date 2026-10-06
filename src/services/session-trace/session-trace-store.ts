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

/** What was last written per device, so a device sending every few seconds costs no write. */
const deviceSeen = new Map<string, { ua: string; at: number }>();
const DEVICE_REWRITE_MS = 60 * 60 * 1000;

/** Remember which browser a device id is. Cheap to call on every batch. */
export function recordTraceDevice(deviceId: string, userAgent: string, now = Date.now()): void {
  const ua = userAgent.slice(0, 512);
  const seen = deviceSeen.get(deviceId);
  if (seen && seen.ua === ua && now - seen.at < DEVICE_REWRITE_MS) return;
  getTraceDb()
    .query(`INSERT INTO trace_devices (device_id, user_agent, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET user_agent = excluded.user_agent, last_seen = excluded.last_seen`)
    .run(deviceId, ua, now);
  deviceSeen.set(deviceId, { ua, at: now });
}

/** Every device's user agent, by device id. */
export function readTraceDevices(): Map<string, string> {
  const rows = getTraceDb().query("SELECT device_id, user_agent FROM trace_devices").all() as { device_id: string; user_agent: string }[];
  return new Map(rows.map((r) => [r.device_id, r.user_agent]));
}

/** One browser row, with the rowid the Logs reader uses as its id and its live-tail cursor. */
export interface BrowserTraceRow {
  rowid: number;
  traceId: string;
  ts: number;
  refId: string | null;
  type: string;
  payloadJson: string;
}

/**
 * Browser rows from `fromTs` on, oldest first — the newest `limit` of them when there are more,
 * since those are what a reader came for; after `afterRowid`, in the order they were written.
 */
export function readBrowserRows(opts: { fromTs?: number; afterRowid?: number; limit?: number }): BrowserTraceRow[] {
  const where = ["source = 'browser'"];
  const args: number[] = [];
  if (opts.fromTs !== undefined && opts.fromTs > 0) { where.push("ts >= ?"); args.push(opts.fromTs); }
  if (opts.afterRowid !== undefined) { where.push("rowid > ?"); args.push(opts.afterRowid); }
  const tail = opts.afterRowid !== undefined;
  const rows = getTraceDb()
    .query(`SELECT rowid, trace_id, ts, ref_id, type, payload_json FROM session_events
      WHERE ${where.join(" AND ")} ORDER BY ${tail ? "rowid" : "ts DESC, rowid DESC"} LIMIT ?`)
    .all(...args, Math.max(1, Math.floor(opts.limit ?? 50_000))) as { rowid: number; trace_id: string; ts: number; ref_id: string | null; type: string; payload_json: string }[];
  if (!tail) rows.reverse();
  return rows.map((r) => ({ rowid: r.rowid, traceId: r.trace_id, ts: r.ts, refId: r.ref_id, type: r.type, payloadJson: r.payload_json }));
}

/** The newest rowid in the table, where a live tail starts. */
export function lastTraceRowid(): number {
  const row = getTraceDb().query("SELECT MAX(rowid) AS id FROM session_events").get() as { id: number | null };
  return row.id ?? 0;
}
