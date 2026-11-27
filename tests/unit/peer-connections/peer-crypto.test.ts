/**
 * Known-answer vectors from the RFCs, so a Bun upgrade that changes `node:crypto`'s X25519 or
 * Ed25519 fails here rather than in a pairing that silently stops agreeing.
 */
import { describe, expect, it } from "bun:test";
import {
  aesGcmOpen, aesGcmSeal, b64u, ed25519PublicFromPrivate, ed25519Sign, ed25519Verify, fingerprintOf, fromB64u,
  generateEd25519, generateX25519, hashSecret, secretMatchesHash, x25519, x25519PublicFromPrivate,
} from "../../../src/services/peer-connections/peer-crypto.ts";

/** A copy of `buf` with one bit changed at `index`. */
const flipByte = (buf: Uint8Array, index: number): Buffer => { const c = Buffer.from(buf); c.writeUInt8(c.readUInt8(index) ^ 1, index); return c; };

const hex = (s: string) => Buffer.from(s, "hex");

describe("X25519 (RFC 7748 §6.1)", () => {
  const alicePriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const alicePub = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  const bobPriv = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPub = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

  it("derives the published public keys and shared secret", () => {
    expect(x25519PublicFromPrivate(alicePriv).toString("hex")).toBe(alicePub.toString("hex"));
    expect(x25519PublicFromPrivate(bobPriv).toString("hex")).toBe(bobPub.toString("hex"));
    expect(x25519(alicePriv, bobPub).toString("hex")).toBe(shared);
    expect(x25519(bobPriv, alicePub).toString("hex")).toBe(shared);
  });

  it("refuses a low-order point that would make the secret all zeros", () => {
    expect(() => x25519(alicePriv, Buffer.alloc(32))).toThrow();
  });

  it("agrees between two generated key pairs", () => {
    const a = generateX25519();
    const b = generateX25519();
    expect(x25519(a.privateKey, b.publicKey).equals(x25519(b.privateKey, a.publicKey))).toBe(true);
  });
});

describe("Ed25519 (RFC 8032 §7.1 test 1)", () => {
  const priv = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const pub = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const sig = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

  it("produces the published signature over the empty message", () => {
    expect(ed25519PublicFromPrivate(priv).toString("hex")).toBe(pub.toString("hex"));
    expect(ed25519Sign(priv, Buffer.alloc(0)).toString("hex")).toBe(sig);
    expect(ed25519Verify(pub, Buffer.alloc(0), hex(sig))).toBe(true);
  });

  it("rejects a changed message, a changed signature and a malformed key without throwing", () => {
    const pair = generateEd25519();
    const s = ed25519Sign(pair.privateKey, Buffer.from("hello"));
    expect(ed25519Verify(pair.publicKey, Buffer.from("hellp"), s)).toBe(false);
    const bad = flipByte(s, 0);
    expect(ed25519Verify(pair.publicKey, Buffer.from("hello"), bad)).toBe(false);
    expect(ed25519Verify(Buffer.alloc(5), Buffer.from("hello"), s)).toBe(false);
    expect(ed25519Verify(pair.publicKey, Buffer.from("hello"), s.subarray(0, 63))).toBe(false);
  });

  it("fingerprints are 8 bytes of hex", () => {
    expect(fingerprintOf(pub)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("AES-256-GCM", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips and refuses any change to ciphertext, nonce or associated data", () => {
    const { nonce, ct } = aesGcmSeal(key, Buffer.from("tin nhắn"), Buffer.from("hdr"));
    expect(aesGcmOpen(key, nonce, ct, Buffer.from("hdr")).toString()).toBe("tin nhắn");
    expect(() => aesGcmOpen(key, nonce, ct, Buffer.from("hds"))).toThrow();
    const ct2 = flipByte(ct, 0);
    expect(() => aesGcmOpen(key, nonce, ct2, Buffer.from("hdr"))).toThrow();
    const n2 = flipByte(nonce, 0);
    expect(() => aesGcmOpen(key, n2, ct, Buffer.from("hdr"))).toThrow();
    expect(() => aesGcmOpen(Buffer.alloc(32, 8), nonce, ct, Buffer.from("hdr"))).toThrow();
  });

  it("draws a fresh nonce per seal", () => {
    const a = aesGcmSeal(key, Buffer.from("x"), Buffer.alloc(0));
    const b = aesGcmSeal(key, Buffer.from("x"), Buffer.alloc(0));
    expect(a.nonce.equals(b.nonce)).toBe(false);
  });
});

describe("encoding and secret hashes", () => {
  it("accepts only canonical base64url of the expected length", () => {
    const v = b64u(Buffer.alloc(16, 1));
    expect(fromB64u(v, 16).length).toBe(16);
    expect(() => fromB64u(v + "=", 16)).toThrow();
    expect(() => fromB64u(v, 32)).toThrow();
    expect(() => fromB64u("a+b/", 3)).toThrow();
  });

  it("matches a secret against its stored hash only", () => {
    const h = hashSecret("cap-1");
    expect(secretMatchesHash("cap-1", h)).toBe(true);
    expect(secretMatchesHash("cap-2", h)).toBe(false);
    expect(secretMatchesHash("cap-1", "abcd")).toBe(false);
  });
});
