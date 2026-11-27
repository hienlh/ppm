/**
 * Cryptographic primitives for connections between two PPMs. Everything goes through `node:crypto`:
 * Bun's WebCrypto has no X25519, and the synchronous API lets an envelope be sealed inside a
 * bun:sqlite transaction (which cannot await), so the sequence number and the stored bytes commit
 * together.
 *
 * Keys are carried as raw 32-byte values in base64url and turned into `KeyObject`s on use.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject,
} from "node:crypto";

export const KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

// DER prefixes that wrap a raw 32-byte key as PKCS#8 (private) or SPKI (public).
const DER = {
  x25519: { pkcs8: "302e020100300506032b656e04220420", spki: "302a300506032b656e032100" },
  ed25519: { pkcs8: "302e020100300506032b657004220420", spki: "302a300506032b6570032100" },
} as const;
type Curve = keyof typeof DER;

export interface RawKeyPair { publicKey: Buffer; privateKey: Buffer }

export const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");

/** Decode base64url, refusing anything that does not round-trip (padding, stray characters). */
export function fromB64u(text: string, expectedBytes?: number): Buffer {
  const buf = Buffer.from(text, "base64url");
  if (buf.toString("base64url") !== text) throw new Error("not canonical base64url");
  if (expectedBytes !== undefined && buf.length !== expectedBytes) throw new Error(`expected ${expectedBytes} bytes, got ${buf.length}`);
  return buf;
}

function privateKeyObject(curve: Curve, raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error(`${curve} private key must be ${KEY_BYTES} bytes`);
  return createPrivateKey({ key: Buffer.concat([Buffer.from(DER[curve].pkcs8, "hex"), raw]), format: "der", type: "pkcs8" });
}

function publicKeyObject(curve: Curve, raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error(`${curve} public key must be ${KEY_BYTES} bytes`);
  return createPublicKey({ key: Buffer.concat([Buffer.from(DER[curve].spki, "hex"), raw]), format: "der", type: "spki" });
}

const rawPublic = (key: KeyObject): Buffer => (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-KEY_BYTES);
const rawPrivate = (key: KeyObject): Buffer => (key.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-KEY_BYTES);

function generate(curve: Curve): RawKeyPair {
  const { publicKey, privateKey } = curve === "x25519" ? generateKeyPairSync("x25519") : generateKeyPairSync("ed25519");
  return { publicKey: rawPublic(publicKey), privateKey: rawPrivate(privateKey) };
}

export const generateX25519 = (): RawKeyPair => generate("x25519");
export const generateEd25519 = (): RawKeyPair => generate("ed25519");

export function x25519PublicFromPrivate(priv: Uint8Array): Buffer {
  return rawPublic(createPublicKey(privateKeyObject("x25519", priv)));
}

export function ed25519PublicFromPrivate(priv: Uint8Array): Buffer {
  return rawPublic(createPublicKey(privateKeyObject("ed25519", priv)));
}

/**
 * X25519 shared secret. An all-zero result means the other side sent a low-order point, which
 * would make the "shared" secret known to anyone; it is refused.
 */
export function x25519(myPrivate: Uint8Array, theirPublic: Uint8Array): Buffer {
  const shared = diffieHellman({ privateKey: privateKeyObject("x25519", myPrivate), publicKey: publicKeyObject("x25519", theirPublic) });
  if (shared.every((b) => b === 0)) throw new Error("x25519 produced an all-zero secret");
  return shared;
}

export function ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Buffer {
  return sign(null, message, privateKeyObject("ed25519", privateKey));
}

/** False for a bad signature or a malformed key; never throws. */
export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (signature.length !== 64) return false;
    return verify(null, message, publicKeyObject("ed25519", publicKey), signature);
  } catch {
    return false;
  }
}

export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length = KEY_BYTES): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length));
}

export interface Sealed { nonce: Buffer; ct: Buffer }

export const newGcmNonce = (): Buffer => randomBytes(GCM_NONCE_BYTES);

/**
 * AES-256-GCM; `ct` carries the 16-byte tag at its end. The nonce is random per call unless the
 * caller drew it first (an envelope names its nonce in the header it authenticates).
 */
export function aesGcmSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array, nonce: Buffer = newGcmNonce()): Sealed {
  if (key.length !== KEY_BYTES) throw new Error("AES-256 key must be 32 bytes");
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error("GCM nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce, ct };
}

/** Throws when the key, nonce, associated data or ciphertext do not match. */
export function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== KEY_BYTES) throw new Error("AES-256 key must be 32 bytes");
  if (nonce.length !== GCM_NONCE_BYTES || ct.length < GCM_TAG_BYTES) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_BYTES));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)), decipher.final()]);
}

/** Constant-time equality that also accepts unequal lengths (answering false). */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The identity fingerprint: the first 8 bytes of SHA-256 of the Ed25519 public key, as hex. */
export function fingerprintOf(identityPublic: Uint8Array): string {
  return sha256(identityPublic).subarray(0, 8).toString("hex");
}

/** SHA-256 of a token or capability, hex, for storing in place of the token itself. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Compare a presented secret with its stored hash in constant time. */
export function secretMatchesHash(secret: string, storedHashHex: string): boolean {
  const stored = Buffer.from(storedHashHex, "hex");
  return stored.length === 32 && safeEqual(Buffer.from(hashSecret(secret), "hex"), stored);
}

export const randomToken = (bytes = KEY_BYTES): string => b64u(randomBytes(bytes));
