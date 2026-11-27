/**
 * The receiving side. Every envelope is checked in a fixed order — its tag and signature (and the
 * clock for control envelopes), then the sequence, and only then decryption — and an ordered one
 * is stored with its body (sealed at rest) in the same transaction that moves `recv_seq`, so it
 * is acknowledged only once it is safe on disk. From there it waits as `received` (or held for
 * quiet hours or a limit) until the connection chat takes it; the body is kept until then, so a
 * restart re-delivers instead of losing it.
 *
 * Before both people have confirmed the six digits, only `confirm` and `close` are taken. A
 * `confirm` is recorded on the connection as it is stored, so the connection turns active the
 * moment the second confirmation exists, whichever side it came from.
 *
 * Every call returns the control envelope to answer with (`ack` or `nack`), already sealed.
 */
import { getDb } from "../db.service.ts";
import {
  isOrderedKind, parsePeerEnvelope, serializePeerEnvelope,
  type PeerBodies, type PeerControlKind, type PeerEnvelope, type PeerOrderedKind,
} from "../../shared/peer-envelope.ts";
import { getPeerConnection, peerConnectionKeys, peerIdentityOf, type PeerConnectionRow } from "./peer-connections-db.ts";
import { safeEqual } from "./peer-crypto.ts";
import { decryptPeerEnvelope, PeerBodyUnreadableError, sealPeerEnvelope, verifyPeerEnvelope, type VerifyFailure } from "./peer-envelope-codec.ts";
import { loadPeerIdentity } from "./peer-identity.ts";
import { openStoredText, sealStored } from "./peer-key-store.ts";
import { applyAck, applyNack, bodyLabel, envelopeLabel, type AckOutcome, type NackOutcome } from "./peer-outbox-db.ts";
import { applyResync, classifyIncoming } from "./peer-replay-guard.ts";

export type IncomingState = "received" | "held_quiet" | "held_limit" | "delivering" | "delivered_to_chat" | "dropped";

/** Seal a control envelope (`seq` 0) for this connection. */
export function sealControl<K extends PeerControlKind>(conn: PeerConnectionRow, kind: K, body: PeerBodies[K], now = Date.now()): PeerEnvelope {
  const identity = loadPeerIdentity();
  const { sendKey, connTag } = peerConnectionKeys(conn);
  return sealPeerEnvelope({ connTag, fromFingerprint: identity.fingerprint, seq: 0, kind, body, sendKey, identityPrivate: identity.privateKey, sentAt: now });
}

export type RejectReason = VerifyFailure | "wrong_connection" | "closed" | "not_confirmed" | "undecryptable";

export type ReceiveResult =
  | { result: "accepted"; messageId: string; kind: PeerOrderedKind; seq: number; reply: PeerEnvelope }
  /** Signed and decrypted, but the body is not one this PPM can read; dropped, and the ack says so. */
  | { result: "refused"; seq: number; reason: string; reply: PeerEnvelope }
  | { result: "duplicate"; reply: PeerEnvelope }
  | { result: "nack"; expectedSeq: number; reply: PeerEnvelope }
  /** Control envelopes: what arrived, after its effect on the queues has been applied. */
  | { result: "control"; kind: PeerControlKind; body: PeerBodies[PeerControlKind]; ack?: AckOutcome; nack?: NackOutcome; resyncLost?: number; reply?: PeerEnvelope }
  /** Never reaches anyone: log the reason (not the content) and still answer the relay with success. */
  | { result: "rejected"; reason: RejectReason };

/**
 * Take one envelope addressed to `conn`. The caller has matched the tag to the connection and
 * parsed the envelope's shape; the tag is checked again here against the signed header, so an
 * envelope of one connection is never acted on under another between the same two machines.
 */
export function receivePeerEnvelope(conn: PeerConnectionRow, env: PeerEnvelope, now = Date.now()): ReceiveResult {
  if (!safeEqual(Buffer.from(env.conn), Buffer.from(conn.conn_tag))) return { result: "rejected", reason: "wrong_connection" };
  if (conn.status === "closed") return { result: "rejected", reason: "closed" };
  const verified = verifyPeerEnvelope(env, peerIdentityOf(conn), now);
  if (!verified.ok) return { result: "rejected", reason: verified.reason };
  return isOrderedKind(env.kind) ? receiveOrdered(conn.id, env, now) : receiveControl(conn, env, now);
}

type Pending =
  | { result: "accepted"; messageId: string; kind: PeerOrderedKind; seq: number }
  | { result: "refused"; seq: number; reason: string }
  | { result: "duplicate" }
  | { result: "nack"; nack: PeerBodies["nack"] }
  | { result: "rejected"; reason: "not_confirmed" | "undecryptable" };

function receiveOrdered(connectionId: string, env: PeerEnvelope, now: number): ReceiveResult {
  const db = getDb();
  const outcome = db.transaction((): Pending => {
    const conn = getPeerConnection(connectionId)!;
    if (conn.status === "pending_confirm" && env.kind !== "confirm" && env.kind !== "close") return { result: "rejected", reason: "not_confirmed" };
    const stored = env.seq <= conn.recv_seq ? storedIncoming(conn.id, env.seq) : null;
    const decision = classifyIncoming(conn.recv_seq, env.seq, env.sig, stored);
    if (decision.action === "duplicate") return { result: "duplicate" };
    if (decision.action === "nack") {
      const nack: PeerBodies["nack"] = { expected_seq: decision.expectedSeq };
      if (decision.conflict) {
        nack.conflict_seq = decision.conflict.seq;
        if (decision.conflict.sig) nack.conflict_sig = decision.conflict.sig;
      }
      return { result: "nack", nack };
    }
    let body: unknown = null;
    let refusal: string | null = null;
    try {
      body = decryptPeerEnvelope(env, peerConnectionKeys(conn).receiveKey);
    } catch (e) {
      if (!(e instanceof PeerBodyUnreadableError)) return { result: "rejected", reason: "undecryptable" };
      refusal = e.message;
    }
    const id = crypto.randomUUID();
    const json = body === null ? null : JSON.stringify(body);
    const msg = env.kind === "msg" && body ? body as PeerBodies["msg"] : null;
    db.query(`INSERT INTO peer_messages (id, connection_id, direction, seq, kind, status, envelope_enc, body_enc, bytes, wait_id, reply_to,
        expects_reply, created_at, delivered_at) VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, conn.id, env.seq, env.kind, refusal ? "dropped" : "received", sealStored(serializePeerEnvelope(env), envelopeLabel(id)),
      json === null ? null : sealStored(json, bodyLabel(id)), json === null ? 0 : Buffer.byteLength(json, "utf8"),
      msg?.wait_id ?? null, msg?.reply_to ?? null, msg?.expects_reply === false ? 0 : 1, now, refusal ? now : null,
    );
    db.query("UPDATE peer_connections SET recv_seq = ?, updated_at = ? WHERE id = ?").run(env.seq, now, conn.id);
    if (env.kind === "confirm" && !refusal) {
      db.query("UPDATE peer_connections SET peer_confirmed_at = COALESCE(peer_confirmed_at, ?) WHERE id = ? AND status = 'pending_confirm'").run(now, conn.id);
      db.query(`UPDATE peer_connections SET status = 'active' WHERE id = ? AND status = 'pending_confirm'
        AND my_confirmed_at IS NOT NULL AND peer_confirmed_at IS NOT NULL`).run(conn.id);
    }
    if (refusal) return { result: "refused", seq: env.seq, reason: refusal };
    return { result: "accepted", messageId: id, kind: env.kind as PeerOrderedKind, seq: env.seq };
  }).immediate();
  if (outcome.result === "rejected") return outcome;
  const conn = getPeerConnection(connectionId)!;
  if (outcome.result === "nack") return { result: "nack", expectedSeq: outcome.nack.expected_seq, reply: sealControl(conn, "nack", outcome.nack, now) };
  const reply = sealControl(conn, "ack", ackBody(conn, outcome.result === "refused"), now);
  return { ...outcome, reply };
}

/** The ack for everything held: the number and the signature of the envelope stored at it. */
function ackBody(conn: PeerConnectionRow, refused = false): PeerBodies["ack"] {
  const at = conn.recv_seq > 0 ? storedIncoming(conn.id, conn.recv_seq) : null;
  return { seq: conn.recv_seq, ...(at ? { sig: at.sig } : {}), ...(refused ? { refused: true } : {}) };
}

function storedIncoming(connectionId: string, seq: number): PeerEnvelope | null {
  const row = getDb().query("SELECT id, envelope_enc FROM peer_messages WHERE connection_id = ? AND direction = 'in' AND seq = ?")
    .get(connectionId, seq) as { id: string; envelope_enc: string | null } | null;
  return row?.envelope_enc ? parsePeerEnvelope(openStoredText(row.envelope_enc, envelopeLabel(row.id))) : null;
}

function receiveControl(conn: PeerConnectionRow, env: PeerEnvelope, now: number): ReceiveResult {
  const kind = env.kind as PeerControlKind;
  let body: PeerBodies[PeerControlKind];
  try {
    body = decryptPeerEnvelope(env as PeerEnvelope & { kind: PeerControlKind }, peerConnectionKeys(conn).receiveKey);
  } catch {
    return { result: "rejected", reason: "undecryptable" };
  }
  switch (kind) {
    case "ack":
      return { result: "control", kind, body, ack: applyAck(conn.id, body as PeerBodies["ack"], now) };
    case "nack":
      return { result: "control", kind, body, nack: applyNack(conn.id, body as PeerBodies["nack"], now) };
    case "resync": {
      const db = getDb();
      const lost = db.transaction(() => {
        const fresh = getPeerConnection(conn.id)!;
        const d = applyResync(fresh.recv_seq, (body as PeerBodies["resync"]).next_seq);
        if (d.action !== "advance") return 0;
        db.query("UPDATE peer_connections SET recv_seq = ?, updated_at = ? WHERE id = ?").run(d.newRecvSeq, now, conn.id);
        return d.lost;
      }).immediate();
      const fresh = getPeerConnection(conn.id)!;
      return { result: "control", kind, body, resyncLost: lost, reply: sealControl(fresh, "ack", ackBody(fresh), now) };
    }
    default:
      return { result: "control", kind, body };
  }
}

/** Messages that reached this side and have not reached the chat yet, oldest first. */
export function pendingIncoming(connectionId: string): Array<{ id: string; seq: number; kind: PeerOrderedKind; status: IncomingState }> {
  return getDb().query(`SELECT id, seq, kind, status FROM peer_messages WHERE connection_id = ? AND direction = 'in'
    AND status IN ('received','held_quiet','held_limit','delivering') ORDER BY seq`).all(connectionId) as never;
}

export function readIncomingBody<K extends PeerOrderedKind>(messageId: string): PeerBodies[K] | null {
  const row = getDb().query("SELECT body_enc FROM peer_messages WHERE id = ? AND direction = 'in'").get(messageId) as { body_enc: string | null } | null;
  return row?.body_enc ? JSON.parse(openStoredText(row.body_enc, bodyLabel(messageId))) : null;
}

/**
 * Move an incoming message along `received → held_* → delivering → delivered_to_chat | dropped`
 * (compare and set). The body is dropped once the message has reached the chat or been dropped.
 */
export function setIncomingState(messageId: string, from: readonly IncomingState[], to: IncomingState, now = Date.now()): boolean {
  const done = to === "delivered_to_chat" || to === "dropped";
  return getDb().query(`UPDATE peer_messages SET status = ?, delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END,
      body_enc = CASE WHEN ? THEN NULL ELSE body_enc END
    WHERE id = ? AND direction = 'in' AND status IN (${from.map(() => "?").join(", ")})`)
    .run(to, done ? 1 : 0, now, done ? 1 : 0, messageId, ...from).changes === 1;
}
