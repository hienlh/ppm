import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  parsePeerEnvelope, PEER_MAX_CLOCK_SKEW_MS, PEER_MAX_ENVELOPE_BYTES, PEER_MAX_PLAINTEXT_BYTES, serializePeerEnvelope, utf8Length,
  type PeerEnvelope,
} from "../../../src/shared/peer-envelope.ts";
import { b64u, fingerprintOf, generateEd25519 } from "../../../src/services/peer-connections/peer-crypto.ts";
import {
  decryptPeerEnvelope, PeerEnvelopeTooLargeError, sealPeerEnvelope, verifyPeerEnvelope,
} from "../../../src/services/peer-connections/peer-envelope-codec.ts";

/** A copy of `buf` with one bit changed at `index`. */
const flipByte = (buf: Uint8Array, index: number): Buffer => { const c = Buffer.from(buf); c.writeUInt8(c.readUInt8(index) ^ 1, index); return c; };

const id = generateEd25519();
const peer = { identityPublic: id.publicKey, fingerprint: fingerprintOf(id.publicKey) };
const key = randomBytes(32);
const connTag = b64u(randomBytes(16));
const now = 1_800_000_000_000;

function seal(text: string, seq = 1, extra: Partial<Parameters<typeof sealPeerEnvelope>[0]> = {}): PeerEnvelope {
  return sealPeerEnvelope({ connTag, fromFingerprint: peer.fingerprint, seq, kind: "msg", body: { text }, sendKey: key, identityPrivate: id.privateKey, sentAt: now, ...extra });
}

describe("peer envelope", () => {
  it("seals, survives the wire, verifies and decrypts", () => {
    const env = parsePeerEnvelope(serializePeerEnvelope(seal("xin chào 👋", 3)));
    expect(verifyPeerEnvelope(env, peer, now)).toEqual({ ok: true });
    expect(decryptPeerEnvelope(env as PeerEnvelope & { kind: "msg" }, key)).toEqual({ text: "xin chào 👋" });
  });

  it("rejects a changed header field, ciphertext or signature", () => {
    const env = seal("hi", 2);
    for (const bad of [{ ...env, seq: 3 }, { ...env, sent_at: env.sent_at + 1 }, { ...env, kind: "close" as const }, { ...env, conn: b64u(randomBytes(16)) }]) {
      expect(verifyPeerEnvelope(bad, peer, now)).toEqual({ ok: false, reason: "bad_signature" });
    }
    const ct = flipByte(Buffer.from(env.ct, "base64url"), 0);
    expect(verifyPeerEnvelope({ ...env, ct: b64u(ct) }, peer, now).ok).toBe(false);
    const sig = flipByte(Buffer.from(env.sig, "base64url"), 10);
    expect(verifyPeerEnvelope({ ...env, sig: b64u(sig) }, peer, now).ok).toBe(false);
  });

  it("rejects a sender that is not the paired identity", () => {
    const other = generateEd25519();
    const env = seal("hi");
    expect(verifyPeerEnvelope(env, { identityPublic: other.publicKey, fingerprint: peer.fingerprint }, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyPeerEnvelope(env, { identityPublic: id.publicKey, fingerprint: fingerprintOf(other.publicKey) }, now)).toEqual({ ok: false, reason: "wrong_sender" });
  });

  it("drops a control envelope more than seven days from the receiver's clock, either way", () => {
    const env = sealPeerEnvelope({ connTag, fromFingerprint: peer.fingerprint, seq: 0, kind: "ack", body: { seq: 1 }, sendKey: key, identityPrivate: id.privateKey, sentAt: now });
    expect(verifyPeerEnvelope(env, peer, now + PEER_MAX_CLOCK_SKEW_MS + 1)).toEqual({ ok: false, reason: "clock_skew" });
    expect(verifyPeerEnvelope(env, peer, now - PEER_MAX_CLOCK_SKEW_MS - 1)).toEqual({ ok: false, reason: "clock_skew" });
    expect(verifyPeerEnvelope(env, peer, now + PEER_MAX_CLOCK_SKEW_MS).ok).toBe(true);
  });

  it("still takes an ordered envelope sealed long ago: its sequence number guards it", () => {
    expect(verifyPeerEnvelope(seal("sealed before the laptop went away"), peer, now + 30 * 24 * 60 * 60 * 1000)).toEqual({ ok: true });
  });

  it("measures an already-parsed envelope against the wire cap too", () => {
    const good = JSON.parse(serializePeerEnvelope(seal("hi")));
    expect(() => parsePeerEnvelope({ ...good, ct: "A".repeat(PEER_MAX_ENVELOPE_BYTES) })).toThrow(/size/);
    expect(parsePeerEnvelope(good).seq).toBe(1);
  });

  it("does not decrypt under the other direction's key", () => {
    expect(() => decryptPeerEnvelope(seal("hi") as PeerEnvelope & { kind: "msg" }, randomBytes(32))).toThrow();
  });

  it("fits a Vietnamese and emoji message right at the plaintext cap under the 64 KB wire cap", () => {
    const unit = "Tiếng Việt có dấu 🇻🇳🎉 ";
    let text = "";
    while (utf8Length(JSON.stringify({ text: text + unit })) <= PEER_MAX_PLAINTEXT_BYTES) text += unit;
    while (utf8Length(JSON.stringify({ text: text + "a" })) <= PEER_MAX_PLAINTEXT_BYTES) text += "a";
    expect(utf8Length(JSON.stringify({ text }))).toBe(PEER_MAX_PLAINTEXT_BYTES);
    const wire = serializePeerEnvelope(seal(text));
    expect(utf8Length(wire)).toBeLessThanOrEqual(PEER_MAX_ENVELOPE_BYTES);
    expect(parsePeerEnvelope(wire).seq).toBe(1);
    expect(() => seal(text + "a")).toThrow(PeerEnvelopeTooLargeError);
  });

  it("counts escaped control characters toward the cap, as they travel", () => {
    const text = "\n".repeat(PEER_MAX_PLAINTEXT_BYTES / 2);
    expect(() => seal(text)).toThrow(PeerEnvelopeTooLargeError);
  });

  it("refuses sequence numbers that do not fit the kind", () => {
    expect(() => seal("hi", 0)).toThrow();
    expect(() => sealPeerEnvelope({ connTag, fromFingerprint: peer.fingerprint, seq: 4, kind: "ack", body: { seq: 4 }, sendKey: key, identityPrivate: id.privateKey })).toThrow();
  });

  it("refuses malformed envelopes before anything else looks at them", () => {
    const good = JSON.parse(serializePeerEnvelope(seal("hi")));
    const cases: Array<Record<string, unknown>> = [
      { ...good, v: 2 }, { ...good, conn: "x" }, { ...good, from: "ZZ" }, { ...good, kind: "accept" }, { ...good, seq: -1 },
      { ...good, seq: 1.5 }, { ...good, kind: "ack" }, { ...good, nonce: good.nonce + "A" }, { ...good, sig: "" }, { ...good, ct: "a b" },
    ];
    for (const c of cases) expect(() => parsePeerEnvelope(JSON.stringify(c))).toThrow();
    expect(() => parsePeerEnvelope("x".repeat(PEER_MAX_ENVELOPE_BYTES + 1))).toThrow(/size/);
    expect(() => parsePeerEnvelope("[]")).toThrow();
  });

  it("validates the decrypted body against its kind", () => {
    expect(() => sealPeerEnvelope({ connTag, fromFingerprint: peer.fingerprint, seq: 1, kind: "msg", body: { text: 5 } as never, sendKey: key, identityPrivate: id.privateKey })).toThrow();
    expect(() => sealPeerEnvelope({ connTag, fromFingerprint: peer.fingerprint, seq: 0, kind: "nack", body: { expected_seq: 0 }, sendKey: key, identityPrivate: id.privateKey })).toThrow();
  });
});
