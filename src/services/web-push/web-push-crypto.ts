/**
 * Web Push message encryption (RFC 8291, `aes128gcm` from RFC 8188) and VAPID
 * (RFC 8292), on WebCrypto alone.
 *
 * No push library: the whole protocol is one ECDH, three HKDFs, one AES-GCM and
 * one ES256 signature, and `web-push` would have added five packages to the
 * compiled binary for it. `tests/unit/services/web-push-crypto.test.ts` checks
 * the output byte for byte against the worked example in RFC 8291 Appendix A.
 */

const encoder = new TextEncoder();

/** Bytes WebCrypto and fetch accept: backed by a plain ArrayBuffer, never a shared one. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** One record, so the payload plus its delimiter and tag must fit in it. */
export const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
/** salt(16) | record size(4) | key id length(1) | key id: the sender's 65-byte public key. */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
/**
 * Largest plaintext a push service has to take. It need not accept a body over 4096 bytes
 * (RFC 8030 §7.2), and the header, the delimiter and the tag come out of that: 3993 bytes
 * (RFC 8291 §4).
 */
export const MAX_PLAINTEXT_BYTES = 4096 - HEADER_LENGTH - 1 - TAG_LENGTH;

export interface EncryptOptions {
  /** Test seams: RFC 8291's example fixes both. Production draws them fresh per message. */
  salt?: Bytes;
  senderKeys?: CryptoKeyPair;
}

/**
 * Encrypt `plaintext` for one subscription.
 *
 * @param receiverPublicKey the subscription's `p256dh` (65-byte uncompressed P-256 point)
 * @param authSecret the subscription's `auth` (16 bytes)
 * @returns the request body: the `aes128gcm` header followed by the single record
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  receiverPublicKey: Bytes,
  authSecret: Bytes,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  if (receiverPublicKey.length !== 65 || receiverPublicKey[0] !== 0x04) {
    throw new Error("p256dh is not an uncompressed P-256 public key");
  }
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error(`payload is ${plaintext.length} bytes; the limit is ${MAX_PLAINTEXT_BYTES}`);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const senderKeys = opts.senderKeys
    ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const senderPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", senderKeys.publicKey));

  const receiverKey = await crypto.subtle.importKey("raw", receiverPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, senderKeys.privateKey, 256),
  );

  // RFC 8291 §3.4: the auth secret salts the ECDH secret, bound to both public keys.
  const keyInfo = concat(encoder.encode("WebPush: info\0"), receiverPublicKey, senderPublicKey);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // 0x02 marks the last (and only) record; no padding.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: TAG_LENGTH * 8 }, aesKey, record),
  );

  // RFC 8188 §2.1 header: salt(16) | record size(4, big-endian) | key id length(1) | key id
  const header = new Uint8Array(16 + 4 + 1 + senderPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublicKey.length;
  header.set(senderPublicKey, 21);
  return concat(header, ciphertext);
}

/** The application server's VAPID key pair. `publicKey` is what browsers pass as `applicationServerKey`. */
export interface VapidKeys {
  publicKey: string;
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64UrlEncode(publicRaw), privateJwk };
}

/** Push services reject a token valid for more than 24 hours; half that leaves room for clock skew. */
const VAPID_TOKEN_LIFETIME_S = 12 * 3600;

/**
 * The `Authorization` header for one push request (RFC 8292 §3).
 *
 * The audience is the push service's origin, so one token serves every
 * subscription on that service — but tokens are cheap, so one is made per request.
 */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + VAPID_TOKEN_LIFETIME_S,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const privateKey = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto signs ECDSA as r||s (64 bytes), which is exactly the JWS ES256 encoding.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(signingInput)),
  );
  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}
