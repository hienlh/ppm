/**
 * The browser's half of Web Push for tests: a subscription's keys, and RFC 8291
 * decryption of what PPM sends to it.
 */
import { expect } from "bun:test";
import { base64UrlEncode } from "../../src/services/web-push/web-push-crypto.ts";

export interface TestReceiver {
  keys: CryptoKeyPair;
  auth: Uint8Array<ArrayBuffer>;
  /** What `PushSubscription.toJSON()` would give for `endpoint`. */
  subscription(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } };
}

export async function makeReceiver(): Promise<TestReceiver> {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys,
    auth,
    subscription: (endpoint) => ({ endpoint, keys: { p256dh: base64UrlEncode(publicRaw), auth: base64UrlEncode(auth) } }),
  };
}

export async function decryptPushBody(
  body: Uint8Array<ArrayBuffer>,
  receiver: Pick<TestReceiver, "keys" | "auth">,
): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.keys.publicKey));
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, receiver.keys.privateKey, 256));
  const hkdf = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, key, len * 8));
  };
  const keyInfo = new Uint8Array([...enc.encode("WebPush: info\0"), ...receiverPublic, ...senderPublic]);
  const ikm = await hkdf(receiver.auth, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idLength)));
  expect(record.at(-1)).toBe(0x02);
  return record.slice(0, -1);
}
