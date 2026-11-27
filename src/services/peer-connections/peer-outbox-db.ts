/**
 * The outgoing queue of one connection. Messages wait as `queued` (or `awaiting_approval` until the
 * person allows them); a message gets its sequence number only when it is sealed, so a refused
 * card leaves no gap. Sealing, numbering and storing the exact bytes happen in one transaction,
 * and a resend is always those same bytes. One message is in flight at a time: the transport asks
 * `nextOutgoingEnvelope`, sends it, and waits for the `ack` before asking again.
 */
import { getDb } from "../db.service.ts";
import { parsePeerEnvelope, serializePeerEnvelope, type PeerBodies, type PeerEnvelope, type PeerOrderedKind } from "../../shared/peer-envelope.ts";
import { getPeerConnection, peerConnectionKeys, type PeerConnectionRow } from "./peer-connections-db.ts";
import { sealPeerEnvelope } from "./peer-envelope-codec.ts";
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

/** Queue an ordered message. Returns its id; the sequence number comes later, when it is sealed. */
export function queueOutgoing<K extends PeerOrderedKind>(connectionId: string, kind: K, body: PeerBodies[K], opts: QueueOptions = {}, now = Date.now()): string {
  const id = crypto.randomUUID();
  const json = JSON.stringify(body);
  getDb().query(`INSERT INTO peer_messages (id, connection_id, direction, kind, status, body_enc, bytes, approval_id, wait_id, reply_to,
      expects_reply, created_at) VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, connectionId, kind, opts.awaitingApproval ? "awaiting_approval" : "queued", sealStored(json, bodyLabel(id)),
    Buffer.byteLength(json, "utf8"), opts.approvalId ?? null, opts.waitId ?? null, opts.replyTo ?? null, opts.expectsReply === false ? 0 : 1, now,
  );
  return id;
}

/** The person's answer on the outgoing card: release the message to the queue, or drop it. */
export function answerOutgoingApproval(id: string, allow: boolean): boolean {
  return getDb().query("UPDATE peer_messages SET status = ?, body_enc = CASE WHEN ? THEN body_enc ELSE NULL END WHERE id = ? AND direction = 'out' AND status = 'awaiting_approval'")
    .run(allow ? "queued" : "dropped", allow ? 1 : 0, id).changes === 1;
}

interface OutRow { id: string; seq: number | null; kind: PeerOrderedKind; body_enc: string | null; envelope_enc: string | null }

export interface Outgoing { messageId: string; seq: number; envelope: PeerEnvelope }

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
    if (inFlight?.envelope_enc) {
      return { messageId: inFlight.id, seq: inFlight.seq!, envelope: parsePeerEnvelope(openStoredText(inFlight.envelope_enc, envelopeLabel(inFlight.id))) };
    }
    const conn = getPeerConnection(connectionId);
    if (!conn || conn.status === "closed") return null;
    const kinds = conn.status === "active" ? "('msg','confirm','grant','close')" : conn.status === "pending_confirm" ? "('confirm','close')" : "('close')";
    const next = db.query(`SELECT id, seq, kind, body_enc, envelope_enc FROM peer_messages WHERE connection_id = ? AND direction = 'out'
      AND status = 'queued' AND kind IN ${kinds} ORDER BY created_at, rowid LIMIT 1`).get(connectionId) as OutRow | null;
    if (!next?.body_enc) return null;
    return sealInto(conn, next, conn.send_seq + 1, now);
  })();
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

/** Give up on the message in flight (the person cancelled, or the connection closed). */
export function failOutgoing(messageId: string): void {
  getDb().query("UPDATE peer_messages SET status = 'failed', body_enc = NULL WHERE id = ? AND direction = 'out' AND status IN ('queued','in_flight','awaiting_approval')").run(messageId);
}

/** A cumulative `ack {seq}`: everything in flight up to `seq` has arrived. Returns how many. */
export function applyAck(connectionId: string, seq: number, now = Date.now()): number {
  return getDb().query(`UPDATE peer_messages SET status = 'delivered', delivered_at = ?, body_enc = NULL, next_attempt_at = NULL
    WHERE connection_id = ? AND direction = 'out' AND status = 'in_flight' AND seq <= ?`).run(now, connectionId, seq).changes;
}

export type NackOutcome = NackPlan & { resyncNextSeq?: number };

/**
 * Act on `nack {expected_seq}` (see `planAfterNack`): put the stored envelopes back in flight to
 * resend them, or renumber what is in flight when this side's numbering went back. For `resync`
 * the caller sends `resync {next_seq}` (a control envelope) before resending.
 */
export function applyNack(connectionId: string, expectedSeq: number, now = Date.now()): NackOutcome {
  const db = getDb();
  return db.transaction((): NackOutcome => {
    const conn = getPeerConnection(connectionId);
    if (!conn) return { action: "ignore" };
    const held = db.query(`SELECT MIN(seq) AS s FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq IS NOT NULL
      AND envelope_enc IS NOT NULL`).get(connectionId) as { s: number | null };
    const flying = db.query(`SELECT MIN(seq) AS s FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND status = 'in_flight'`)
      .get(connectionId) as { s: number | null };
    const plan = planAfterNack(expectedSeq, conn.send_seq, held.s, flying.s);
    if (plan.action === "resend" || plan.action === "resync") {
      const from = plan.action === "resend" ? plan.from : plan.nextSeq;
      db.query(`UPDATE peer_messages SET status = 'in_flight', next_attempt_at = NULL WHERE connection_id = ? AND direction = 'out'
        AND seq BETWEEN ? AND ? AND envelope_enc IS NOT NULL`).run(connectionId, from, plan.to);
      return plan.action === "resync" ? { ...plan, resyncNextSeq: plan.nextSeq } : plan;
    }
    if (plan.action === "jump") {
      // Free the numbers first, then reseal every message in flight in order from the new base.
      const rows = db.query(`SELECT id, seq, kind, body_enc, envelope_enc FROM peer_messages WHERE connection_id = ? AND direction = 'out'
        AND status = 'in_flight' ORDER BY seq`).all(connectionId) as OutRow[];
      for (const r of rows) db.query("UPDATE peer_messages SET seq = NULL, envelope_enc = NULL WHERE id = ?").run(r.id);
      db.query("UPDATE peer_connections SET send_seq = ?, updated_at = ? WHERE id = ?").run(plan.newSendSeq, now, connectionId);
      let seq = plan.newSendSeq;
      for (const r of rows) {
        if (!r.body_enc) { db.query("UPDATE peer_messages SET status = 'failed' WHERE id = ?").run(r.id); continue; }
        sealInto(getPeerConnection(connectionId)!, r, ++seq, now);
      }
    }
    return plan;
  })();
}

export function outgoingStatus(messageId: string): string | null {
  return (getDb().query("SELECT status FROM peer_messages WHERE id = ?").get(messageId) as { status: string } | null)?.status ?? null;
}
