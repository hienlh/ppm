/**
 * This PPM's long-lived identity for peer connections: an Ed25519 key pair in
 * `<ppm dir>/peer-identity.<db>.json` (0600). Created the first time it is needed. The fingerprint
 * (first 8 bytes of SHA-256 of the public key) is what people see and compare.
 */
import { statSync } from "node:fs";
import { b64u, ed25519PublicFromPrivate, fingerprintOf, fromB64u, generateEd25519, KEY_BYTES, safeEqual } from "./peer-crypto.ts";
import { createSecretFile, fileExists, PeerKeyFileError, peerSecretPath, readSecretFile } from "./peer-secret-file.ts";

export interface PeerIdentity {
  publicKey: Buffer;
  privateKey: Buffer;
  fingerprint: string;
}

interface Cached { path: string; mtimeMs: number; size: number; identity: PeerIdentity }
let cached: Cached | null = null;

export function peerIdentityPath(): string {
  return peerSecretPath("peer-identity", "json");
}

function parseIdentity(path: string, data: Buffer): PeerIdentity | null {
  if (data.length === 0) return null; // claimed by another process, not written yet
  let raw: { v?: unknown; publicKey?: unknown; privateKey?: unknown };
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    throw new PeerKeyFileError(path, "the identity file is not valid JSON");
  }
  if (raw?.v !== 1 || typeof raw.publicKey !== "string" || typeof raw.privateKey !== "string") {
    throw new PeerKeyFileError(path, "the identity file is missing its keys");
  }
  let privateKey: Buffer;
  let publicKey: Buffer;
  try {
    privateKey = fromB64u(raw.privateKey, KEY_BYTES);
    publicKey = fromB64u(raw.publicKey, KEY_BYTES);
  } catch {
    throw new PeerKeyFileError(path, "the identity keys are malformed");
  }
  if (!safeEqual(ed25519PublicFromPrivate(privateKey), publicKey)) {
    throw new PeerKeyFileError(path, "the identity's public key does not match its private key");
  }
  return { publicKey, privateKey, fingerprint: fingerprintOf(publicKey) };
}

/** This PPM's identity, created on first use. Throws `PeerKeyFileError` if the file is damaged. */
export function loadPeerIdentity(): PeerIdentity {
  const path = peerIdentityPath();
  if (!fileExists(path)) {
    const pair = generateEd25519();
    createSecretFile(path, JSON.stringify({
      v: 1, publicKey: b64u(pair.publicKey), privateKey: b64u(pair.privateKey), createdAt: Date.now(),
    }));
  }
  const st = statSync(path);
  if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.identity;
  const identity = readSecretFile(path, (data) => parseIdentity(path, data), "the identity file is empty");
  cached = { path, mtimeMs: st.mtimeMs, size: st.size, identity };
  return identity;
}

/** Forget the cached identity (tests). */
export function resetPeerIdentityCache(): void {
  cached = null;
}
