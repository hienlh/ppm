import { getDb } from "../db.service.ts";
import {
  ASSISTANT_CARD_KINDS, ASSISTANT_CARD_STATUSES, WAITING_CARD_KINDS,
  type AssistantCardAnswer, type AssistantCardKind, type AssistantCardPayload, type AssistantCardStatus,
} from "../../shared/assistant-cards.ts";

/**
 * Storage for the PPM Assistant's cards (`assistant_cards`, migration 65). Every status change is
 * compare-and-set on the status the caller read, so of two surfaces answering one card only the
 * first changes it. Kinds and statuses are checked here as well as by the table's CHECKs.
 */

export type CardWake = "none" | "pending" | "delivered";
export type CardOutbound = "pending" | "held" | "sent" | "skipped";

export interface CardRow {
  id: string;
  kind: AssistantCardKind;
  projectKey: string | null;
  sessionId: string | null;
  title: string;
  body: string;
  payload: AssistantCardPayload & { projectName?: string };
  status: AssistantCardStatus;
  answer: AssistantCardAnswer | null;
  outbound: CardOutbound;
  wake: CardWake;
  createdAt: number;
  updatedAt: number;
}

interface Raw {
  id: string; kind: string; project_key: string | null; session_id: string | null; title: string; body: string;
  payload_json: string | null; status: string; answer_json: string | null; outbound: string; wake: string;
  created_at: number; updated_at: number;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? value as T : fallback;
  } catch {
    return fallback;
  }
}

const toRow = (r: Raw): CardRow => ({
  id: r.id,
  kind: r.kind as AssistantCardKind,
  projectKey: r.project_key,
  sessionId: r.session_id,
  title: r.title,
  body: r.body,
  payload: parse(r.payload_json, {}),
  status: r.status as AssistantCardStatus,
  answer: parse<AssistantCardAnswer | null>(r.answer_json, null),
  outbound: r.outbound as CardOutbound,
  wake: r.wake as CardWake,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS = "id, kind, project_key, session_id, title, body, payload_json, status, answer_json, outbound, wake, created_at, updated_at";

export interface NewCardRow {
  kind: AssistantCardKind;
  projectKey: string | null;
  sessionId: string | null;
  title: string;
  body: string;
  payload: CardRow["payload"];
  status: AssistantCardStatus;
  wake: CardWake;
  at: number;
}

export function insertCardRow(input: NewCardRow): CardRow {
  if (!ASSISTANT_CARD_KINDS.includes(input.kind)) throw new Error(`Unknown card kind "${String(input.kind)}"`);
  if (!ASSISTANT_CARD_STATUSES.includes(input.status)) throw new Error(`Unknown card status "${String(input.status)}"`);
  const id = crypto.randomUUID();
  getDb().query(`INSERT INTO assistant_cards (id, kind, project_key, session_id, title, body, payload_json, status, wake, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.kind, input.projectKey, input.sessionId, input.title, input.body, JSON.stringify(input.payload),
    input.status, input.wake, input.at, input.at,
  );
  return getCardRow(id)!;
}

export function getCardRow(id: string): CardRow | null {
  const row = getDb().query(`SELECT ${COLUMNS} FROM assistant_cards WHERE id = ?`).get(id) as Raw | null;
  return row ? toRow(row) : null;
}

/** Moves a card from `from` to `to`; false when its status is no longer `from` (someone else won). */
export function casCardStatus(id: string, from: AssistantCardStatus, to: AssistantCardStatus, answer: AssistantCardAnswer | null, at: number): boolean {
  if (!ASSISTANT_CARD_STATUSES.includes(to)) throw new Error(`Unknown card status "${String(to)}"`);
  return getDb().query("UPDATE assistant_cards SET status = ?, answer_json = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, answer ? JSON.stringify(answer) : null, at, id, from).changes > 0;
}

export function setCardWake(id: string, wake: CardWake, at: number): boolean {
  return getDb().query("UPDATE assistant_cards SET wake = ?, updated_at = ? WHERE id = ?").run(wake, at, id).changes > 0;
}

export interface CardQuery {
  /** Only cards created before this time (ms), newest first. */
  before?: number;
  limit: number;
  projectKey?: string;
}

export function listCardRows(q: CardQuery): CardRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (q.before !== undefined) { where.push("created_at < ?"); args.push(q.before); }
  if (q.projectKey !== undefined) { where.push("project_key = ?"); args.push(q.projectKey); }
  const sql = `SELECT ${COLUMNS} FROM assistant_cards ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return (getDb().query(sql).all(...args, q.limit) as Raw[]).map(toRow);
}

/** Every open card of the given kinds (all waiting kinds by default), oldest first. */
export function listOpenCardRows(kinds: readonly AssistantCardKind[] = WAITING_CARD_KINDS): CardRow[] {
  const marks = kinds.map(() => "?").join(", ");
  return (getDb().query(`SELECT ${COLUMNS} FROM assistant_cards WHERE status = 'open' AND kind IN (${marks}) ORDER BY created_at`)
    .all(...kinds) as Raw[]).map(toRow);
}

export function listWakePendingRows(): CardRow[] {
  return (getDb().query(`SELECT ${COLUMNS} FROM assistant_cards WHERE wake = 'pending' ORDER BY created_at`).all() as Raw[]).map(toRow);
}

/** Cards a manager chat filed or raised since `since`, of the given kinds. */
export function countSessionCardsSince(sessionIds: readonly string[], kinds: readonly AssistantCardKind[], since: number): number {
  if (sessionIds.length === 0 || kinds.length === 0) return 0;
  const ids = sessionIds.map(() => "?").join(", ");
  const ks = kinds.map(() => "?").join(", ");
  const row = getDb().query(`SELECT COUNT(*) AS n FROM assistant_cards WHERE session_id IN (${ids}) AND kind IN (${ks}) AND created_at >= ?`)
    .get(...sessionIds, ...kinds, since) as { n: number };
  return row.n;
}

/** An open urgent card of this manager chat with exactly this title, created since `since`. */
export function findOpenUrgentTitled(sessionId: string, title: string, since: number): CardRow | null {
  const row = getDb().query(`SELECT ${COLUMNS} FROM assistant_cards
    WHERE status = 'open' AND kind = 'urgent' AND session_id = ? AND title = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1`).get(sessionId, title, since) as Raw | null;
  return row ? toRow(row) : null;
}

/** The open card mirroring `requestId` in a manager chat, if any. */
export function findOpenRequestCard(requestId: string): CardRow | null {
  const row = getDb().query(`SELECT ${COLUMNS} FROM assistant_cards
    WHERE status = 'open' AND kind IN ('approval', 'question') AND json_extract(payload_json, '$.requestId') = ?
    ORDER BY created_at DESC LIMIT 1`).get(requestId) as Raw | null;
  return row ? toRow(row) : null;
}

/** Open cards of one kind whose payload field equals `value` (a budget's session, a held rules hash). */
export function findOpenCardsBy(kind: AssistantCardKind, field: string, value: string): CardRow[] {
  if (!/^[a-zA-Z]+$/.test(field)) throw new Error("bad field");
  return (getDb().query(`SELECT ${COLUMNS} FROM assistant_cards
    WHERE status = 'open' AND kind = ? AND json_extract(payload_json, '$.${field}') = ? ORDER BY created_at`)
    .all(kind, value) as Raw[]).map(toRow);
}
