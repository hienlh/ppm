/**
 * Sealing and opening envelopes. Sealing encrypts the JSON body with the sender's direction key
 * (the header as associated data) and signs header + ciphertext with the sender's identity.
 *
 * Opening is split so the receiver checks in a fixed order — signature and clock
 * (`verifyPeerEnvelope`), then the sequence (`peer-replay-guard.ts`), and only then decryption
 * (`decryptPeerEnvelope`) — and nothing unauthenticated is ever decrypted or acted on.
 */
import {
  isOrderedKind, peerEnvelopeHeaderString, PEER_ENVELOPE_VERSION, PEER_MAX_CLOCK_SKEW_MS, PEER_MAX_ENVELOPE_BYTES,
  PEER_MAX_PLAINTEXT_BYTES, serializePeerEnvelope, utf8Length, validatePeerBody,
  type PeerBodies, type PeerEnvelope, type PeerEnvelopeHeader, type PeerEnvelopeKind,
} from "../../shared/peer-envelope.ts";
import { aesGcmOpen, aesGcmSeal, b64u, ed25519Sign, ed25519Verify, fromB64u, newGcmNonce } from "./peer-crypto.ts";

export class PeerEnvelopeTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`message is ${bytes} bytes; the limit is ${limit}`);
    this.name = "PeerEnvelopeTooLargeError";
  }
}

export interface SealInput<K extends PeerEnvelopeKind> {
  connTag: string;
  fromFingerprint: string;
  seq: number;
  kind: K;
  body: PeerBodies[K];
  /** Key for this side's sending direction. */
  sendKey: Uint8Array;
  identityPrivate: Uint8Array;
  sentAt?: number;
}

const aadOf = (header: PeerEnvelopeHeader): Buffer => Buffer.from(peerEnvelopeHeaderString(header), "utf8");
const signedBytes = (header: PeerEnvelopeHeader, ct: string): Buffer =>
  Buffer.from(`${peerEnvelopeHeaderString(header)}\n${ct}`, "utf8");

export function sealPeerEnvelope<K extends PeerEnvelopeKind>(input: SealInput<K>): PeerEnvelope {
  if (isOrderedKind(input.kind) ? input.seq < 1 : input.seq !== 0) throw new Error("sequence number does not fit the kind");
  const plaintext = JSON.stringify(validatePeerBody(input.kind, input.body));
  const bytes = utf8Length(plaintext);
  if (bytes > PEER_MAX_PLAINTEXT_BYTES) throw new PeerEnvelopeTooLargeError(bytes, PEER_MAX_PLAINTEXT_BYTES);

  // The header names the nonce and is authenticated by the AEAD, so the nonce is drawn first.
  const nonce = newGcmNonce();
  const header: PeerEnvelopeHeader = {
    v: PEER_ENVELOPE_VERSION, conn: input.connTag, from: input.fromFingerprint, seq: input.seq,
    sent_at: input.sentAt ?? Date.now(), kind: input.kind, nonce: b64u(nonce),
  };
  const { ct } = aesGcmSeal(input.sendKey, Buffer.from(plaintext, "utf8"), aadOf(header), nonce);
  const ctText = b64u(ct);
  const env: PeerEnvelope = { ...header, ct: ctText, sig: b64u(ed25519Sign(input.identityPrivate, signedBytes(header, ctText))) };
  const wire = utf8Length(serializePeerEnvelope(env));
  if (wire > PEER_MAX_ENVELOPE_BYTES) throw new PeerEnvelopeTooLargeError(wire, PEER_MAX_ENVELOPE_BYTES);
  return env;
}

export type VerifyFailure = "bad_signature" | "wrong_sender" | "clock_skew";

function headerOf(env: PeerEnvelope): PeerEnvelopeHeader {
  const { v, conn, from, seq, sent_at, kind, nonce } = env;
  return { v, conn, from, seq, sent_at, kind, nonce };
}

/**
 * Authenticate an envelope against the identity the connection was paired with. Checks nothing
 * about the sequence and decrypts nothing.
 */
export function verifyPeerEnvelope(
  env: PeerEnvelope,
  peer: { identityPublic: Uint8Array; fingerprint: string },
  now = Date.now(),
): { ok: true } | { ok: false; reason: VerifyFailure } {
  if (env.from !== peer.fingerprint) return { ok: false, reason: "wrong_sender" };
  let sig: Buffer;
  try {
    sig = fromB64u(env.sig, 64);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!ed25519Verify(peer.identityPublic, signedBytes(headerOf(env), env.ct), sig)) return { ok: false, reason: "bad_signature" };
  if (Math.abs(now - env.sent_at) > PEER_MAX_CLOCK_SKEW_MS) return { ok: false, reason: "clock_skew" };
  return { ok: true };
}

/**
 * Decrypt and validate the body. Call only after `verifyPeerEnvelope` and the sequence check.
 * Throws when the key is wrong or the body does not fit its kind.
 */
export function decryptPeerEnvelope<K extends PeerEnvelopeKind>(env: PeerEnvelope & { kind: K }, receiveKey: Uint8Array): PeerBodies[K] {
  const plaintext = aesGcmOpen(receiveKey, fromB64u(env.nonce, 12), fromB64u(env.ct), aadOf(headerOf(env)));
  return validatePeerBody(env.kind, JSON.parse(plaintext.toString("utf8")));
}
