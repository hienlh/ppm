/**
 * The outgoing queue of one connection. Messages wait as `queued` (or `awaiting_approval` until the
 * person allows them); a message gets its sequence number only when it is sealed, so a refused
 * card leaves no gap. Sealing, numbering and storing the exact bytes happen in one transaction,
 * and a resend is always those same bytes. One message is in flight at a time: the transport asks
 * `nextOutgoingEnvelope`, sends it, and waits for the `ack` before asking again.
 *
 * A sealed message cannot be withdrawn: once it has a number it may already have arrived, and the
 * number cannot be left empty without the receiver waiting for it forever.
 */
import { getDb } from "../db.service.ts";
import {
  parsePeerEnvelope, PEER_MAX_PLAINTEXT_BYTES, serializePeerEnvelope, utf8Length, validatePeerBody,
  type PeerBodies, type PeerEnvelope, type PeerOrderedKind,
} from "../../shared/peer-envelope.ts";
import { getPeerConnection, peerConnectionKeys, type PeerConnectionRow } from "./peer-connections-db.ts";
import { PeerEnvelopeTooLargeError, sealPeerEnvelope } from "./peer-envelope-codec.ts";
import { loadPeerIdentity } from "./peer-identity.ts";
import { openStoredText, sealStored } from "./peer-key-store.ts";
import { planAfterNack, type NackPlan } from "./peer-replay-guard.ts";

export const bodyLabel = (id: string) => `peer_messages.body_enc:${id}`;
export const envelopeLabel = (id: string) => `peer_messages.envelope_enc:${id}`;

export interface QueueOptions {
  awaitingApproval?: boolean;
  approvalId?: string | null;
  waitId?: string | null;
  replyTo?: number | null;
  expectsReply?: boolean;
}

/**
 * Queue an ordered message. Returns its id; the sequence number comes later, when it is sealed.
 * The body is checked here, so a message that could never be sealed is refused at once instead of
 * blocking every message behind it.
 */
export function queueOutgoing<K extends PeerOrderedKind>(connectionId: string, kind: K, body: PeerBodies[K], opts: QueueOptions = {}, now = Date.now()): string {
  const json = JSON.stringify(validatePeerBody(kind, body));
  const bytes = utf8Length(json);
  if (bytes > PEER_MAX_PLAINTEXT_BYTES) throw new PeerEnvelopeTooLargeError(bytes, PEER_MAX_PLAINTEXT_BYTES);
  const id = crypto.randomUUID();
  getDb().query(`INSERT INTO peer_messages (id, connection_id, direction, kind, status, body_enc, bytes, approval_id, wait_id, reply_to,
      expects_reply, created_at) VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, connectionId, kind, opts.awaitingApproval ? "awaiting_approval" : "queued", sealStored(json, bodyLabel(id)),
    bytes, opts.approvalId ?? null, opts.waitId ?? null, opts.replyTo ?? null, opts.expectsReply === false ? 0 : 1, now,
  );
  return id;
}

/** The person's answer on the outgoing card: release the message to the queue, or drop it. */
export function answerOutgoingApproval(id: string, allow: boolean): boolean {
  return getDb().query("UPDATE peer_messages SET status = ?, body_enc = CASE WHEN ? THEN body_enc ELSE NULL END WHERE id = ? AND direction = 'out' AND status = 'awaiting_approval'")
    .run(allow ? "queued" : "dropped", allow ? 1 : 0, id).changes === 1;
}

/** Withdraw a message that has not been sealed yet. False once it has a number (see above). */
export function cancelOutgoing(messageId: string): boolean {
  return getDb().query("UPDATE peer_messages SET status = 'failed', body_enc = NULL WHERE id = ? AND direction = 'out' AND status IN ('queued','awaiting_approval')")
    .run(messageId).changes === 1;
}

interface OutRow { id: string; seq: number | null; kind: PeerOrderedKind; body_enc: string | null; envelope_enc: string | null }

export interface Outgoing { messageId: string; seq: number; envelope: PeerEnvelope }

const storedEnvelope = (row: { id: string; envelope_enc: string | null }): PeerEnvelope | null =>
  row.envelope_enc ? parsePeerEnvelope(openStoredText(row.envelope_enc, envelopeLabel(row.id))) : null;

/** This side's sealed envelope at `seq`, or null when none is kept. */
function outgoingAt(connectionId: string, seq: number): PeerEnvelope | null {
  const row = getDb().query(`SELECT id, envelope_enc FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq = ?
    AND status IN ('in_flight','delivered')`).get(connectionId, seq) as { id: string; envelope_enc: string | null } | null;
  return row ? storedEnvelope(row) : null;
}

/**
 * The envelope to send now, or null when nothing is waiting. The lowest-numbered message in
 * flight is returned again (a resend, same bytes) until it is acknowledged; otherwise the oldest
 * queued message is sealed under the next number. Before the connection is active only `confirm`
 * (and `close`) go out; `grant` and `msg` wait until both people have confirmed. A paused
 * connection sends only `close`.
 */
export function nextOutgoingEnvelope(connectionId: string, now = Date.now()): Outgoing | null {
  const db = getDb();
  return db.transaction((): Outgoing | null => {
    const inFlight = db.query(`SELECT id, seq, kind, body_enc, envelope_enc FROM peer_messages
      WHERE connection_id = ? AND direction = 'out' AND status = 'in_flight' ORDER BY seq LIMIT 1`).get(connectionId) as OutRow | null;
    const resend = inFlight && storedEnvelope(inFlight);
    if (inFlight && resend) return { messageId: inFlight.id, seq: inFlight.seq!, envelope: resend };
    const conn = getPeerConnection(connectionId);
    if (!conn || conn.status === "closed") return null;
    const kinds = conn.status === "active" ? "('msg','confirm','grant','close')" : conn.status === "pending_confirm" ? "('confirm','close')" : "('close')";
    const next = db.query(`SELECT id, seq, kind, body_enc, envelope_enc FROM peer_messages WHERE connection_id = ? AND direction = 'out'
      AND status = 'queued' AND kind IN ${kinds} ORDER BY created_at, rowid LIMIT 1`).get(connectionId) as OutRow | null;
    if (!next?.body_enc) return null;
    return sealInto(conn, next, conn.send_seq + 1, now);
  }).immediate();
}

function sealInto(conn: PeerConnectionRow, row: OutRow, seq: number, now: number): Outgoing {
  const db = getDb();
  const body = JSON.parse(openStoredText(row.body_enc!, bodyLabel(row.id)));
  const identity = loadPeerIdentity();
  const { sendKey, connTag } = peerConnectionKeys(conn);
  const envelope = sealPeerEnvelope({ connTag, fromFingerprint: identity.fingerprint, seq, kind: row.kind, body, sendKey, identityPrivate: identity.privateKey, sentAt: now });
  db.query("UPDATE peer_messages SET seq = ?, status = 'in_flight', envelope_enc = ? WHERE id = ?")
    .run(seq, sealStored(serializePeerEnvelope(envelope), envelopeLabel(row.id)), row.id);
  db.query("UPDATE peer_connections SET send_seq = MAX(send_seq, ?), updated_at = ? WHERE id = ?").run(seq, now, conn.id);
  return { messageId: row.id, seq, envelope };
}

/** Count a send attempt that failed, and when to try again. */
export function noteSendAttempt(messageId: string, nextAttemptAt: number | null): void {
  getDb().query("UPDATE peer_messages SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?").run(nextAttemptAt, messageId);
}

export type AckOutcome = { applied: number; refused: boolean } | { applied: 0; ignored: "unknown_envelope" | "empty" };

/**
 * A cumulative `ack {seq, sig}`: everything in flight up to `seq` has arrived. Applied only when
 * this side's own envelope at `seq` carries `sig`; an ack for a number this side holds under other
 * bytes, or not at all, is about a history this side no longer has and changes nothing. With
 * `refused`, the message at `seq` reached the other side but could not be read there; it is
 * marked failed rather than delivered.
 */
export function applyAck(connectionId: string, ack: PeerBodies["ack"], now = Date.now()): AckOutcome {
  const db = getDb();
  return db.transaction((): AckOutcome => {
    if (ack.seq < 1 || !ack.sig) return { applied: 0, ignored: "empty" };
    const mine = outgoingAt(connectionId, ack.seq);
    if (!mine || mine.sig !== ack.sig) return { applied: 0, ignored: "unknown_envelope" };
    const applied = db.query(`UPDATE peer_messages SET status = 'delivered', delivered_at = ?, body_enc = NULL, next_attempt_at = NULL
      WHERE connection_id = ? AND direction = 'out' AND status = 'in_flight' AND seq <= ?`).run(now, connectionId, ack.seq).changes;
    if (ack.refused) db.query("UPDATE peer_messages SET status = 'failed' WHERE connection_id = ? AND direction = 'out' AND seq = ?").run(connectionId, ack.seq);
    return { applied, refused: ack.refused === true };
  }).immediate();
}

/** The smallest `s` such that `s..sendSeq` are all still held here (`sendSeq + 1` if the newest is not). */
function heldFrom(connectionId: string, from: number, sendSeq: number): number {
  const seqs = getDb().query(`SELECT seq FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq BETWEEN ? AND ?
    AND envelope_enc IS NOT NULL AND status IN ('in_flight','delivered') ORDER BY seq DESC`).all(connectionId, from, sendSeq) as Array<{ seq: number }>;
  let lowest = sendSeq + 1;
  for (const { seq } of seqs) {
    if (seq !== lowest - 1) break;
    lowest = seq;
  }
  return lowest;
}

export type NackOutcome = NackPlan & { resyncNextSeq?: number };

/**
 * Act on a `nack` (see `planAfterNack`): put the stored envelopes back in flight to resend them,
 * or renumber what is in flight when this side's numbering provably went back. For `resync` the
 * caller sends `resync {next_seq}` (a control envelope) before resending.
 */
export function applyNack(connectionId: string, nack: PeerBodies["nack"], now = Date.now()): NackOutcome {
  const db = getDb();
  return db.transaction((): NackOutcome => {
    const conn = getPeerConnection(connectionId);
    if (!conn) return { action: "ignore" };
    let conflictIsOurs: boolean | null = null;
    if (nack.conflict_seq !== undefined) {
      const mine = outgoingAt(connectionId, nack.conflict_seq);
      conflictIsOurs = mine !== null && mine.sig !== nack.conflict_sig;
    }
    const plan = planAfterNack({
      expectedSeq: nack.expected_seq, sendSeq: conn.send_seq, conflictIsOurs,
      heldFrom: heldFrom(connectionId, Math.max(1, nack.expected_seq), conn.send_seq),
    });
    if (plan.action === "resend" || plan.action === "resync") {
      const from = plan.action === "resend" ? plan.from : plan.nextSeq;
      db.query(`UPDATE peer_messages SET status = 'in_flight', next_attempt_at = NULL WHERE connection_id = ? AND direction = 'out'
        AND seq BETWEEN ? AND ? AND envelope_enc IS NOT NULL AND status IN ('in_flight','delivered')`).run(connectionId, from, plan.to);
      return plan.action === "resync" ? { ...plan, resyncNextSeq: plan.nextSeq } : plan;
    }
    if (plan.action === "jump") {
      // Free the numbers first, then reseal every message in flight in order from the new base.
      // A message put back in flight for a resend has already given up its body: it was delivered
      // once, keeps its number, and goes back to `delivered`.
      db.query(`UPDATE peer_messages SET status = 'delivered' WHERE connection_id = ? AND direction = 'out' AND status = 'in_flight'
        AND body_enc IS NULL`).run(connectionId);
      const rows = db.query(`SELECT id, seq, kind, body_enc, envelope_enc FROM peer_messages WHERE connection_id = ? AND direction = 'out'
        AND status = 'in_flight' ORDER BY seq`).all(connectionId) as OutRow[];
      for (const r of rows) db.query("UPDATE peer_messages SET seq = NULL, envelope_enc = NULL WHERE id = ?").run(r.id);
      db.query("UPDATE peer_connections SET send_seq = ?, updated_at = ? WHERE id = ?").run(plan.newSendSeq, now, connectionId);
      let seq = plan.newSendSeq;
      for (const r of rows) sealInto(getPeerConnection(connectionId)!, r, ++seq, now);
    }
    return plan;
  }).immediate();
}

export function outgoingStatus(messageId: string): string | null {
  return (getDb().query("SELECT status FROM peer_messages WHERE id = ?").get(messageId) as { status: string } | null)?.status ?? null;
}
