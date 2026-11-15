import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import type { VaultLockedTier } from "../../shared/vault.ts";

/**
 * The vault's cryptography, and nothing else: no database, no clock, no logging.
 *
 * Each locked tier has its own random data key (DEK). The DEK is wrapped with AES-256-GCM under a
 * key derived from the tier's password (KEK, scrypt), and every item is encrypted under the DEK
 * with a fresh nonce on each write. The additional data binds a ciphertext to its tier and its
 * item id, so a ciphertext copied onto another item, or an item whose `tier` column is edited
 * to move it from `sealed` to `secure`, fails to decrypt instead of opening under the wrong key.
 *
 * A wrong password is told apart only by the wrapped DEK's tag failing; no password hash is kept.
 */

export interface KdfParams { N: number; r: number; p: number }

/** scrypt N=2^17, r=8, p=1: 128 MiB and ~0.2 s per derivation. Stored per tier so it can change. */
export const VAULT_KDF_PARAMS: KdfParams = { N: 2 ** 17, r: 8, p: 1 };
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const SALT_BYTES = 32;
const AAD_PREFIX = "ppm-vault-v1";

const dekAad = (tier: VaultLockedTier) => Buffer.from(`${AAD_PREFIX}|dek|${tier}`, "utf8");
const itemAad = (tier: VaultLockedTier, itemId: string) => Buffer.from(`${AAD_PREFIX}|item|${tier}|${itemId}`, "utf8");

/** Bounds a stored `kdf_params` so a tampered row cannot ask for gigabytes or nothing at all. */
export function parseKdfParams(json: string): KdfParams {
  const v = JSON.parse(json) as Partial<KdfParams>;
  const ok = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
  if (!ok(v.N, 2 ** 10, 2 ** 20) || ((v.N as number) & ((v.N as number) - 1)) !== 0 || !ok(v.r, 1, 32) || !ok(v.p, 1, 4)) {
    throw new Error("Unsupported vault key parameters");
  }
  return { N: v.N as number, r: v.r as number, p: v.p as number };
}

// One derivation at a time across the process: each holds 128 MiB, and a burst of wrong
// passwords must not stack them.
let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every derivation queued before it; the vault's attempt checks run inside it. */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** KEK for `password` under `salt`. Not serialized itself; callers go through `serialized`. */
export function deriveKek(password: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  // NFC so the same password typed through different input methods derives the same key.
  const pw = Buffer.from(password.normalize("NFC"), "utf8");
  const maxmem = 128 * params.N * params.r * 2;
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(pw, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) => {
      pw.fill(0);
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export const newSalt = (): Buffer => randomBytes(SALT_BYTES);
export const newDek = (): Buffer => randomBytes(KEY_BYTES);

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

/** The plaintext, or null when the key, nonce, data or tag do not match. Never throws on those. */
function open(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer | null {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

export function wrapDek(kek: Buffer, dek: Buffer, tier: VaultLockedTier): { nonce: Buffer; wrapped: Buffer } {
  const { nonce, ciphertext } = seal(kek, dek, dekAad(tier));
  return { nonce, wrapped: ciphertext };
}

/** The DEK, or null for a wrong password (or a row that was tampered with). */
export function unwrapDek(kek: Buffer, nonce: Buffer, wrapped: Buffer, tier: VaultLockedTier): Buffer | null {
  const dek = open(kek, nonce, wrapped, dekAad(tier));
  return dek && dek.length === KEY_BYTES ? dek : null;
}

export interface VaultPayload { value: string; note?: string }

export function encryptItem(dek: Buffer, tier: VaultLockedTier, itemId: string, payload: VaultPayload): { nonce: Buffer; ciphertext: Buffer } {
  const plain = Buffer.from(JSON.stringify(payload.note ? { value: payload.value, note: payload.note } : { value: payload.value }), "utf8");
  try {
    return seal(dek, plain, itemAad(tier, itemId));
  } finally {
    plain.fill(0);
  }
}

/** The item's payload, or null when it does not decrypt under this key, tier and id. */
export function decryptItem(dek: Buffer, tier: VaultLockedTier, itemId: string, nonce: Buffer, ciphertext: Buffer): VaultPayload | null {
  const plain = open(dek, nonce, ciphertext, itemAad(tier, itemId));
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain.toString("utf8")) as Partial<VaultPayload>;
    if (typeof parsed.value !== "string") return null;
    return typeof parsed.note === "string" ? { value: parsed.value, note: parsed.note } : { value: parsed.value };
  } catch {
    return null;
  } finally {
    plain.fill(0);
  }
}
