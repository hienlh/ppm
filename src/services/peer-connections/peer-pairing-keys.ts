/**
 * The pairing key schedule: commitment, transcript, root key, the six digits both people compare,
 * and the per-direction keys.
 *
 * The digits are bound to a commitment, as in Bluetooth numeric comparison and ZRTP. The invite
 * carries `C = SHA-256(N_a)`; the inviter reveals `N_a` only after the acceptor's ephemeral key has
 * arrived, and both mix `N_a` into the digits. Without it, someone who swapped the invite could
 * try ~2^20 ephemeral keys until both screens showed the same six digits. With it, they must pick
 * their key before `N_a` is known, so a match is down to the 1-in-a-million guess.
 *
 * Roles: `a` is the inviter, `b` the acceptor. `k_ab` encrypts what the inviter sends.
 */
import { randomBytes } from "node:crypto";
import { hkdf, safeEqual, sha256, x25519, KEY_BYTES } from "./peer-crypto.ts";

export const INVITE_ID_BYTES = 16;
export const COMMIT_NONCE_BYTES = 32;
export const CONN_TAG_BYTES = 16;
export const SAS_DIGITS = 6;

export interface PairingPublics {
  inviteId: Uint8Array;
  inviterIdentity: Uint8Array;
  inviterEphemeral: Uint8Array;
  acceptorIdentity: Uint8Array;
  acceptorEphemeral: Uint8Array;
  commitment: Uint8Array;
}

export interface PairingKeys {
  root: Buffer;
  /** Inviter → acceptor. */
  kAb: Buffer;
  /** Acceptor → inviter. */
  kBa: Buffer;
  connTag: Buffer;
  transcript: Buffer;
}

export function newCommitNonce(): Buffer {
  return randomBytes(COMMIT_NONCE_BYTES);
}

export function commitmentOf(nonce: Uint8Array): Buffer {
  if (nonce.length !== COMMIT_NONCE_BYTES) throw new Error("commit nonce must be 32 bytes");
  return sha256(nonce);
}

/** True when a revealed nonce opens the commitment. */
export function checkReveal(nonce: Uint8Array, commitment: Uint8Array): boolean {
  return nonce.length === COMMIT_NONCE_BYTES && safeEqual(sha256(nonce), commitment);
}

function checkLengths(p: PairingPublics): void {
  if (p.inviteId.length !== INVITE_ID_BYTES) throw new Error("invite id must be 16 bytes");
  for (const k of [p.inviterIdentity, p.inviterEphemeral, p.acceptorIdentity, p.acceptorEphemeral, p.commitment]) {
    if (k.length !== KEY_BYTES) throw new Error("pairing keys must be 32 bytes");
  }
}

/**
 * Everything both sides saw while pairing, in a fixed order (inviter's keys, then the acceptor's).
 * Every field has a fixed length, so plain concatenation is unambiguous.
 */
export function pairingTranscript(p: PairingPublics): Buffer {
  checkLengths(p);
  return sha256(
    Buffer.from("ppm-peer transcript v1", "utf8"),
    p.inviteId, p.inviterIdentity, p.inviterEphemeral, p.acceptorIdentity, p.acceptorEphemeral, p.commitment,
  );
}

/** Keys for the connection, derived from the X25519 secret and the transcript. */
export function derivePairingKeys(shared: Uint8Array, p: PairingPublics): PairingKeys {
  const transcript = pairingTranscript(p);
  const root = hkdf(shared, transcript, "ppm-peer root v1");
  return { ...directionalKeys(root), root, transcript };
}

/** The per-direction keys and the connection tag; the root key alone is what gets stored. */
export function directionalKeys(root: Uint8Array): { kAb: Buffer; kBa: Buffer; connTag: Buffer } {
  const none = Buffer.alloc(0);
  return {
    kAb: hkdf(root, none, "ppm-peer a->b v1"),
    kBa: hkdf(root, none, "ppm-peer b->a v1"),
    connTag: hkdf(root, none, "ppm-peer tag v1", CONN_TAG_BYTES),
  };
}

/**
 * The six digits. 32 bits of the derived value reduced modulo 10^6 (as Bluetooth does); the bias
 * that leaves is under 1 in 4000 per value and changes nothing about the 1-in-a-million guess.
 */
export function shortAuthString(shared: Uint8Array, commitNonce: Uint8Array, p: PairingPublics): string {
  if (commitNonce.length !== COMMIT_NONCE_BYTES) throw new Error("commit nonce must be 32 bytes");
  const transcript = pairingTranscript(p);
  const out = hkdf(Buffer.concat([shared, commitNonce]), transcript, "ppm-peer sas v1", 4);
  return String(out.readUInt32BE(0) % 10 ** SAS_DIGITS).padStart(SAS_DIGITS, "0");
}

export interface PairingSide {
  myEphemeralPrivate: Uint8Array;
  theirEphemeralPublic: Uint8Array;
}

/** One side's full computation once the commitment is open: keys plus the digits to show. */
export function completePairing(side: PairingSide, commitNonce: Uint8Array, p: PairingPublics): PairingKeys & { sas: string } {
  if (!checkReveal(commitNonce, p.commitment)) throw new Error("revealed nonce does not open the commitment");
  const shared = x25519(side.myEphemeralPrivate, side.theirEphemeralPublic);
  return { ...derivePairingKeys(shared, p), sas: shortAuthString(shared, commitNonce, p) };
}
