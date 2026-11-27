/**
 * The envelope every message between two connected PPMs travels in, whatever the transport. This
 * file is the format and its structural checks only; sealing and opening (encryption, signatures)
 * live in `src/services/peer-connections/peer-envelope-codec.ts`.
 *
 * Wire shape: `{ v, conn, from, seq, sent_at, kind, nonce, ct, sig }`
 * - `conn`: the connection tag, 16 bytes derived from the root key, so a relay sees only the tag.
 * - `from`: the sender's identity fingerprint (8 bytes, hex).
 * - `seq`: ordered kinds count 1, 2, 3… per direction; control kinds carry 0.
 * - `ct`: AES-256-GCM of the JSON body, with the header as associated data.
 * - `sig`: Ed25519 over the header and `ct`.
 */

export const PEER_ENVELOPE_VERSION = 1;
/** The whole serialised envelope, in UTF-8 bytes: the cap shared by the MCP endpoint, the
 *  Tailscale route and the relay. */
export const PEER_MAX_ENVELOPE_BYTES = 64 * 1024;
/** The JSON body before encryption. Base64 grows it by a third, so 44 KB leaves room for the
 *  header and the signature under the 64 KB wire cap. */
export const PEER_MAX_PLAINTEXT_BYTES = 44 * 1024;
/**
 * A control envelope whose `sent_at` is further than this from the receiver's clock is dropped.
 * Ordered envelopes are not: their sequence number already stops a replay, and a message sealed
 * before the other side went offline for a week must still arrive rather than wedge the queue.
 */
export const PEER_MAX_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/** Kinds that take the next sequence number and are delivered in order, exactly once. */
export const PEER_ORDERED_KINDS = ["msg", "confirm", "grant", "close"] as const;
/** Kinds outside the sequence (`seq` 0): acknowledgements, resynchronisation and status. `reveal`
 *  opens the pairing commitment before either side has confirmed. */
export const PEER_CONTROL_KINDS = ["ack", "nack", "resync", "status_req", "status", "reveal"] as const;
export type PeerOrderedKind = typeof PEER_ORDERED_KINDS[number];
export type PeerControlKind = typeof PEER_CONTROL_KINDS[number];
export type PeerEnvelopeKind = PeerOrderedKind | PeerControlKind;

export interface PeerEnvelope {
  v: 1;
  conn: string;
  from: string;
  seq: number;
  sent_at: number;
  kind: PeerEnvelopeKind;
  nonce: string;
  ct: string;
  sig: string;
}

export type PeerEnvelopeHeader = Omit<PeerEnvelope, "ct" | "sig">;

/** Status values a receiving server answers with, never decided by an AI. */
export type PeerChatStatus = "running" | "waiting_for_user" | "idle" | "quiet_hours" | "paused";

/** Decrypted bodies, by kind. */
export interface PeerBodies {
  msg: {
    text: string;
    reply_to?: number;
    wait_id?: string;
    expects_reply?: boolean;
    request?: { kind: "session"; task: string; project?: string };
  };
  /** The person on the sending side has confirmed the six digits. Carries no capability. */
  confirm: Record<string, never>;
  /**
   * The right to send to this side. Sent only once the connection is active, i.e. after both
   * people confirmed, so a pairing that is never confirmed hands nothing usable to the other end.
   */
  grant: { transport: "relay"; send_cap: string; mailbox_id: string } | { transport: "tailscale"; inbound_token: string };
  close: { reason?: string };
  /**
   * Cumulative: every ordered envelope up to `seq` has been stored, the one at `seq` being the
   * envelope with signature `sig` (absent when nothing has been stored yet). The sender applies
   * it only when its own envelope at `seq` has that signature, so an old ack replayed after the
   * sender's database went back cannot mark a different message delivered. `refused`: the
   * envelope at `seq` arrived but its body could not be read here (a newer format), and was dropped.
   */
  ack: { seq: number; sig?: string; refused?: boolean };
  /**
   * The receiver holds everything below `expected_seq`. Without `conflict_seq` it is a gap: the
   * sender resends. With it, the sender's envelope at `conflict_seq` is not the one the receiver
   * holds there (signature `conflict_sig`, absent if no copy is kept): the sender's numbering
   * went back, and only then does it renumber forward.
   */
  nack: { expected_seq: number; conflict_seq?: number; conflict_sig?: string };
  /** The sender no longer holds anything below `next_seq`; the receiver moves past the gap. */
  resync: { next_seq: number };
  status_req: { wait_id?: string };
  status: { state: PeerChatStatus; wait_id?: string; reply?: string };
  /** The inviter's commitment value `N_a`, base64url. */
  reveal: { nonce: string };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const HEX = /^[0-9a-f]+$/;
const KINDS: readonly string[] = [...PEER_ORDERED_KINDS, ...PEER_CONTROL_KINDS];

/** Base64url lengths (no padding) of the fixed-size fields. */
const TAG_CHARS = 22; // 16 bytes
const NONCE_CHARS = 16; // 12 bytes
const SIG_CHARS = 86; // 64 bytes
const FINGERPRINT_HEX = 16; // 8 bytes

export function isOrderedKind(kind: PeerEnvelopeKind): kind is PeerOrderedKind {
  return (PEER_ORDERED_KINDS as readonly string[]).includes(kind);
}

const isB64 = (v: unknown, len?: number): v is string =>
  typeof v === "string" && B64URL.test(v) && (len === undefined || v.length === len);

/**
 * Parse and check an envelope's shape. Throws on anything malformed: oversize input, unknown
 * fields' types, a `seq` that does not fit the kind. Says nothing about whether it is authentic.
 */
export function parsePeerEnvelope(input: string | unknown): PeerEnvelope {
  let raw: unknown = input;
  // An object a transport already parsed (a JSON request body) is measured as it would travel.
  const text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (utf8Length(text) > PEER_MAX_ENVELOPE_BYTES) throw new Error("envelope over the size limit");
  if (typeof input === "string") raw = JSON.parse(input);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("envelope is not an object");
  const e = raw as Record<string, unknown>;
  if (e.v !== PEER_ENVELOPE_VERSION) throw new Error("unsupported envelope version");
  if (!isB64(e.conn, TAG_CHARS)) throw new Error("bad connection tag");
  if (typeof e.from !== "string" || e.from.length !== FINGERPRINT_HEX || !HEX.test(e.from)) throw new Error("bad sender fingerprint");
  if (typeof e.kind !== "string" || !KINDS.includes(e.kind)) throw new Error("unknown envelope kind");
  const kind = e.kind as PeerEnvelopeKind;
  if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 0) throw new Error("bad sequence number");
  if (isOrderedKind(kind) ? e.seq < 1 : e.seq !== 0) throw new Error("sequence number does not fit the kind");
  if (typeof e.sent_at !== "number" || !Number.isSafeInteger(e.sent_at) || e.sent_at <= 0) throw new Error("bad sent_at");
  if (!isB64(e.nonce, NONCE_CHARS)) throw new Error("bad nonce");
  if (!isB64(e.ct) || e.ct.length < 22) throw new Error("bad ciphertext");
  if (!isB64(e.sig, SIG_CHARS)) throw new Error("bad signature");
  return { v: 1, conn: e.conn, from: e.from, seq: e.seq, sent_at: e.sent_at, kind, nonce: e.nonce, ct: e.ct, sig: e.sig };
}

export function serializePeerEnvelope(env: PeerEnvelope): string {
  const { v, conn, from, seq, sent_at, kind, nonce, ct, sig } = env;
  return JSON.stringify({ v, conn, from, seq, sent_at, kind, nonce, ct, sig });
}

/**
 * The bytes the header contributes to the AEAD's associated data and to the signature, in a fixed
 * order. Every field is checked to contain no newline, so the joined string is unambiguous.
 */
export function peerEnvelopeHeaderString(h: PeerEnvelopeHeader): string {
  return ["ppm-peer-env", h.v, h.conn, h.from, h.seq, h.sent_at, h.kind, h.nonce].join("\n");
}

const encoder = new TextEncoder();

/** UTF-8 byte length; `TextEncoder` rather than `Buffer` so the browser can use this file. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** True when two envelopes are the same bytes on the wire (a resend of one stored copy). */
export function samePeerEnvelope(a: PeerEnvelope, b: PeerEnvelope): boolean {
  return a.conn === b.conn && a.seq === b.seq && a.kind === b.kind && a.nonce === b.nonce && a.ct === b.ct && a.sig === b.sig;
}

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/**
 * Check a decrypted body against its kind. Returns the body typed, or throws. The text fields have
 * no separate cap: the plaintext limit already bounds them.
 */
export function validatePeerBody<K extends PeerEnvelopeKind>(kind: K, body: unknown): PeerBodies[K] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${kind} body is not an object`);
  const b = body as Record<string, unknown>;
  const fail = (what: string): never => { throw new Error(`${kind} body: ${what}`); };
  switch (kind) {
    case "msg": {
      if (typeof b.text !== "string") fail("text");
      if (b.reply_to !== undefined && !posInt(b.reply_to)) fail("reply_to");
      if (b.wait_id !== undefined && !str(b.wait_id, 64)) fail("wait_id");
      if (b.expects_reply !== undefined && typeof b.expects_reply !== "boolean") fail("expects_reply");
      if (b.request !== undefined) {
        const r = b.request as Record<string, unknown> | null;
        if (!r || typeof r !== "object" || r.kind !== "session" || typeof r.task !== "string") fail("request");
        if (r!.project !== undefined && !str(r!.project, 500)) fail("request.project");
      }
      break;
    }
    case "confirm":
      if (Object.keys(b).length !== 0) fail("must be empty");
      break;
    case "grant":
      if (b.transport === "relay") {
        if (!isB64(b.send_cap) || !str(b.mailbox_id, 200)) fail("relay capability");
      } else if (b.transport === "tailscale") {
        if (!isB64(b.inbound_token)) fail("inbound token");
      } else fail("transport");
      break;
    case "close":
      if (b.reason !== undefined && !str(b.reason, 500)) fail("reason");
      break;
    case "ack":
      if (typeof b.seq !== "number" || !Number.isSafeInteger(b.seq) || b.seq < 0) fail("seq");
      if (b.sig !== undefined && !isB64(b.sig, SIG_CHARS)) fail("sig");
      if (b.refused !== undefined && typeof b.refused !== "boolean") fail("refused");
      break;
    case "nack":
      if (!posInt(b.expected_seq)) fail("expected_seq");
      if (b.conflict_seq !== undefined && !posInt(b.conflict_seq)) fail("conflict_seq");
      if (b.conflict_sig !== undefined && (b.conflict_seq === undefined || !isB64(b.conflict_sig, SIG_CHARS))) fail("conflict_sig");
      break;
    case "resync":
      if (!posInt(b.next_seq)) fail("next_seq");
      break;
    case "status_req":
      if (b.wait_id !== undefined && !str(b.wait_id, 64)) fail("wait_id");
      break;
    case "status":
      if (!["running", "waiting_for_user", "idle", "quiet_hours", "paused"].includes(b.state as string)) fail("state");
      if (b.wait_id !== undefined && !str(b.wait_id, 64)) fail("wait_id");
      if (b.reply !== undefined && typeof b.reply !== "string") fail("reply");
      break;
    case "reveal":
      if (!isB64(b.nonce, 43)) fail("nonce");
      break;
  }
  return body as PeerBodies[K];
}
