import { describe, expect, it } from "bun:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
  generateVapidKeys,
  MAX_PLAINTEXT_BYTES,
  vapidAuthorization,
} from "../../../src/services/web-push/web-push-crypto.ts";
import { decryptPushBody, makeReceiver } from "../../helpers/web-push-receiver.ts";

// RFC 8291 Appendix A, copied from https://www.rfc-editor.org/rfc/rfc8291.txt (whitespace removed).
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

async function ecdhPair(publicB64: string, privateB64: string): Promise<CryptoKeyPair> {
  const pub = base64UrlDecode(publicB64);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: base64UrlEncode(pub.slice(1, 33)),
    y: base64UrlEncode(pub.slice(33, 65)),
    d: privateB64,
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

describe("encryptPushPayload", () => {
  it("reproduces RFC 8291 Appendix A byte for byte", async () => {
    const body = await encryptPushPayload(
      base64UrlDecode(RFC.plaintext),
      base64UrlDecode(RFC.uaPublic),
      base64UrlDecode(RFC.authSecret),
      { salt: base64UrlDecode(RFC.salt), senderKeys: await ecdhPair(RFC.asPublic, RFC.asPrivate) },
    );
    const header = base64UrlDecode(RFC.header);
    expect(header.length).toBe(86);
    expect(Buffer.from(body.slice(0, 86)).equals(Buffer.from(header))).toBe(true);
    expect(base64UrlEncode(body.slice(86))).toBe(RFC.ciphertext);
  });

  it("decrypts back to the payload with fresh keys and salt", async () => {
    const receiver = await makeReceiver();
    const sub = receiver.subscription("https://push.example/1");
    const payload = new TextEncoder().encode(JSON.stringify({ title: "Chat finished", body: "ppm — Tiếng Việt ✓" }));
    const body = await encryptPushPayload(payload, base64UrlDecode(sub.keys.p256dh), receiver.auth);
    expect(new TextDecoder().decode(await decryptPushBody(body, receiver))).toBe(new TextDecoder().decode(payload));
  });

  it("refuses keys of the wrong shape and payloads that do not fit one record", async () => {
    const auth = new Uint8Array(16);
    const ua = base64UrlDecode(RFC.uaPublic);
    await expect(encryptPushPayload(new Uint8Array(1), ua.slice(1), auth)).rejects.toThrow("p256dh");
    await expect(encryptPushPayload(new Uint8Array(1), ua, new Uint8Array(8))).rejects.toThrow("auth secret");
    await expect(encryptPushPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), ua, auth)).rejects.toThrow("limit");
  });

  it("keeps the largest payload it takes within the 4096-byte body every push service accepts", async () => {
    // RFC 8291 §4: 3993 bytes of plaintext, once the 86-byte header, delimiter and tag are added.
    const body = await encryptPushPayload(new Uint8Array(MAX_PLAINTEXT_BYTES), base64UrlDecode(RFC.uaPublic), new Uint8Array(16));
    expect(body.length).toBe(4096);
  });
});

describe("vapidAuthorization", () => {
  it("signs an ES256 token for the push service's origin that verifies with the public key", async () => {
    const keys = await generateVapidKeys();
    expect(base64UrlDecode(keys.publicKey).length).toBe(65);
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", keys, "https://github.com/hienlh/ppm", 1_000_000);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, token, k] = match!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = token!.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com", exp: 1_000_000 + 12 * 3600, sub: "https://github.com/hienlh/ppm",
    });
    const publicKey = await crypto.subtle.importKey("raw", base64UrlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey, base64UrlDecode(s!), new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });
});
