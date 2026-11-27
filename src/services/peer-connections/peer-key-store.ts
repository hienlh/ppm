/**
 * Encrypts the peer-connection secrets kept in `ppm.db` (root keys, capabilities, stored envelopes
 * and bodies) under a 32-byte key in `<ppm dir>/peer-keys.<db>.key` (0600). A copy of `ppm.db` or
 * one of its backups therefore holds no usable key; the key file is excluded from backups and sits
 * where every filesystem door already refuses to go.
 *
 * Each value is sealed with a label naming where it is stored (`peer_connections.root_key_enc:<id>`),
 * passed as associated data, so a ciphertext copied into another row or column does not open.
 *
 * Format: `pk1.<nonce b64url>.<ciphertext+tag b64url>`.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { aesGcmOpen, aesGcmSeal, b64u, fromB64u, KEY_BYTES } from "./peer-crypto.ts";
import { createSecretFile, fileExists, PeerKeyFileError, peerSecretPath, peerStateExists, readSecretFile } from "./peer-secret-file.ts";

const PREFIX = "pk1";

interface Cached { path: string; mtimeMs: number; size: number; key: Buffer }
let cached: Cached | null = null;

export function peerKeyStorePath(): string {
  return peerSecretPath("peer-keys", "key");
}

/**
 * The storage key. Created only when `create` is set (a write) and nothing sealed exists yet;
 * otherwise a missing key throws, since a fresh key could never open what was sealed before.
 */
function loadKey(create: boolean): Buffer {
  const path = peerKeyStorePath();
  if (!fileExists(path)) {
    if (!create || peerStateExists()) throw new PeerKeyFileError(path, "the storage key file is missing");
    createSecretFile(path, randomBytes(KEY_BYTES));
  }
  const st = statSync(path);
  if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.key;
  const key = readSecretFile(path, (data) => {
    if (data.length === 0) return null;
    if (data.length !== KEY_BYTES) throw new PeerKeyFileError(path, `the storage key file has ${data.length} bytes, not ${KEY_BYTES}`);
    return Buffer.from(data);
  }, "the storage key file is empty");
  cached = { path, mtimeMs: st.mtimeMs, size: st.size, key };
  return key;
}

const aadFor = (label: string): Buffer => Buffer.from(`ppm-peer store v1\n${label}`, "utf8");

export function sealStored(plaintext: Uint8Array | string, label: string): string {
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const { nonce, ct } = aesGcmSeal(loadKey(true), data, aadFor(label));
  return `${PREFIX}.${b64u(nonce)}.${b64u(ct)}`;
}

/** Throws when the value is malformed, the label differs, or the key is not the one it was sealed under. */
export function openStored(sealed: string, label: string): Buffer {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error("not a sealed peer value");
  return aesGcmOpen(loadKey(false), fromB64u(parts[1]!), fromB64u(parts[2]!), aadFor(label));
}

export const openStoredText = (sealed: string, label: string): string => openStored(sealed, label).toString("utf8");

/** Forget the cached key (tests). */
export function resetPeerKeyStoreCache(): void {
  cached = null;
}
