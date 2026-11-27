/**
 * Two PPMs, each with its own database and keys, pair through an invite and then exchange
 * messages through the outbox and inbox. The "network" is a function call that hands the sealed
 * envelope across, so lost answers, delayed copies, restored databases and pruned history can be
 * staged exactly.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { getDb } from "../../../src/services/db.service.ts";
import { PEER_PRESET_DEFAULTS } from "../../../src/shared/peer-connections.ts";
import {
  parsePeerEnvelope, peerEnvelopeHeaderString, serializePeerEnvelope, type PeerEnvelope, type PeerEnvelopeKind,
} from "../../../src/shared/peer-envelope.ts";
import { aesGcmSeal, b64u, ed25519Sign, fingerprintOf, fromB64u, generateX25519, randomToken, x25519 } from "../../../src/services/peer-connections/peer-crypto.ts";
import { checkReveal, commitmentOf, derivePairingKeys, newCommitNonce, shortAuthString, type PairingPublics } from "../../../src/services/peer-connections/peer-pairing-keys.ts";
import { decodeAccept, decodeInvite, encodeAccept, encodeInvite } from "../../../src/services/peer-connections/peer-invite-code.ts";
import { loadPeerIdentity } from "../../../src/services/peer-connections/peer-identity.ts";
import {
  claimPeerInvite, insertPeerInvite, linkPeerInviteConnection, peerInviteCodeHash, prunePeerState,
} from "../../../src/services/peer-connections/peer-invites-db.ts";
import {
  getPeerConnection, getPeerConnectionByTag, insertPeerConnection, peerConnectionKeys, readPeerSecret, recordPeerConfirmation, storePeerSecret,
} from "../../../src/services/peer-connections/peer-connections-db.ts";
import { PeerEnvelopeTooLargeError } from "../../../src/services/peer-connections/peer-envelope-codec.ts";
import { applyNack, cancelOutgoing, nextOutgoingEnvelope, outgoingStatus, queueOutgoing } from "../../../src/services/peer-connections/peer-outbox-db.ts";
import { pendingIncoming, readIncomingBody, receivePeerEnvelope, sealControl, setIncomingState } from "../../../src/services/peer-connections/peer-inbox-db.ts";
import { leavePeerSides, makePeerSide, type PeerSide } from "./two-peer-sides.ts";

afterAll(leavePeerSides);

const wire = (env: PeerEnvelope) => parsePeerEnvelope(serializePeerEnvelope(env));
const DAY = 24 * 60 * 60 * 1000;

interface Paired { a: PeerSide; b: PeerSide; aConn: string; bConn: string; sasA: string; sasB: string; inviteCode: string; pairSecret: string; root: Buffer }

/** Pair two sides through an invite. Pass existing sides to make a second connection between them. */
function pair(sides?: { a: PeerSide; b: PeerSide }): Paired {
  const a = sides?.a ?? makePeerSide("inviter");
  const b = sides?.b ?? makePeerSide("acceptor");
  const pairSecret = randomToken();
  const { code, invite } = a.run(() => {
    const id = loadPeerIdentity();
    const eph = generateX25519();
    const nonce = newCommitNonce();
    const invite = { inviteId: randomBytes(16), inviterEphemeral: eph.publicKey, inviterIdentity: id.publicKey, commitment: commitmentOf(nonce), pairSecret, hint: { tailscale: { host: "a.tail.ts.net" } }, label: "Máy A", expiresAt: Date.now() + 15 * 60_000 };
    const code = encodeInvite(invite, id.privateKey);
    insertPeerInvite({ inviteId: invite.inviteId, code, ephemeralPrivate: eph.privateKey, commitNonce: nonce, commitment: invite.commitment, pairSecret, pairMailboxId: null, label: "Máy B", transport: "tailscale", preset: "mine", expiresAt: invite.expiresAt, createdBy: "user" });
    return { code, invite };
  });
  // Acceptor: read the code, answer with an accept, store its half.
  const { acceptText, bConn, acceptorEph } = b.run(() => {
    const inv = decodeInvite(code);
    const id = loadPeerIdentity();
    const eph = generateX25519();
    const acceptText = encodeAccept({ inviteId: inv.inviteId, acceptorEphemeral: eph.publicKey, acceptorIdentity: id.publicKey, pairSecret: inv.pairSecret, claimedName: "laptop", sentAt: Date.now() }, code, id.privateKey);
    const publics: PairingPublics = { inviteId: inv.inviteId, inviterIdentity: inv.inviterIdentity, inviterEphemeral: inv.inviterEphemeral, acceptorIdentity: id.publicKey, acceptorEphemeral: eph.publicKey, commitment: inv.commitment };
    const keys = derivePairingKeys(x25519(eph.privateKey, inv.inviterEphemeral), publics);
    const row = insertPeerConnection({ label: "Máy A", peerClaimedName: "", peerFingerprint: fingerprintOf(inv.inviterIdentity), peerIdentityPublic: inv.inviterIdentity, myRole: "acceptor", root: keys.root, transport: "tailscale", inviteAcceptedBy: "user", settings: PEER_PRESET_DEFAULTS.mine, tailscaleHost: "a.tail.ts.net" });
    return { acceptText, bConn: row.id, acceptorEph: eph };
  });
  // Inviter: take the accept through the pairing door, derive keys, reveal the nonce.
  const { aConn, sasA, reveal, root } = a.run(() => {
    const acc = decodeAccept(acceptText, peerInviteCodeHash);
    const claim = claimPeerInvite(b64u(acc.inviteId), acc.pairSecret);
    if (!claim.ok) throw new Error(claim.reason);
    const id = loadPeerIdentity();
    const publics: PairingPublics = { inviteId: acc.inviteId, inviterIdentity: id.publicKey, inviterEphemeral: invite.inviterEphemeral, acceptorIdentity: acc.acceptorIdentity, acceptorEphemeral: acc.acceptorEphemeral, commitment: invite.commitment };
    const shared = x25519(claim.invite.ephemeralPrivate, acc.acceptorEphemeral);
    const keys = derivePairingKeys(shared, publics);
    const row = insertPeerConnection({ label: "Máy B", peerClaimedName: acc.claimedName, peerFingerprint: fingerprintOf(acc.acceptorIdentity), peerIdentityPublic: acc.acceptorIdentity, myRole: "inviter", root: keys.root, transport: "tailscale", inviteAcceptedBy: null, settings: PEER_PRESET_DEFAULTS.mine });
    linkPeerInviteConnection(b64u(acc.inviteId), row.id);
    return { aConn: row.id, sasA: shortAuthString(shared, claim.invite.commitNonce, publics), reveal: sealControl(row, "reveal", { nonce: b64u(claim.invite.commitNonce) }), root: keys.root };
  });
  // Acceptor: open the commitment and compute the digits.
  const sasB = b.run(() => {
    const r = receivePeerEnvelope(getPeerConnection(bConn)!, wire(reveal));
    if (r.result !== "control" || r.kind !== "reveal") throw new Error("reveal not received");
    const nonce = fromB64u((r.body as { nonce: string }).nonce, 32);
    expect(checkReveal(nonce, invite.commitment)).toBe(true);
    const publics: PairingPublics = { inviteId: invite.inviteId, inviterIdentity: invite.inviterIdentity, inviterEphemeral: invite.inviterEphemeral, acceptorIdentity: loadPeerIdentity().publicKey, acceptorEphemeral: acceptorEph.publicKey, commitment: invite.commitment };
    return shortAuthString(x25519(acceptorEph.privateKey, invite.inviterEphemeral), nonce, publics);
  });
  return { a, b, aConn, bConn, sasA, sasB, inviteCode: code, pairSecret, root };
}

/**
 * Send everything `from` has ready to `to`, one in flight at a time, answering each with its
 * reply. `replies` collects what `to` answered, so a test can replay one later.
 */
function pump(from: PeerSide, fromConn: string, to: PeerSide, toConn: string, opts: { dropReply?: boolean; replies?: PeerEnvelope[] } = {}): string[] {
  const results: string[] = [];
  for (let i = 0; i < 20; i++) {
    const out = from.run(() => nextOutgoingEnvelope(fromConn));
    if (!out) break;
    const r = to.run(() => receivePeerEnvelope(getPeerConnection(toConn)!, wire(out.envelope)));
    results.push(r.result);
    if (r.result === "rejected" || opts.dropReply || !("reply" in r) || !r.reply) break;
    opts.replies?.push(r.reply);
    const back = from.run(() => receivePeerEnvelope(getPeerConnection(fromConn)!, wire(r.reply!)));
    if (back.result === "control" && back.kind === "nack" && back.nack?.action === "resync") {
      const env = from.run(() => sealControl(getPeerConnection(fromConn)!, "resync", { next_seq: back.nack!.resyncNextSeq! }));
      const rr = to.run(() => receivePeerEnvelope(getPeerConnection(toConn)!, wire(env)));
      results.push(`resync:${rr.result === "control" ? rr.resyncLost : "?"}`);
    }
  }
  return results;
}

/** Seal any plaintext as `side` would, bypassing body validation, to stage what a newer PPM might send. */
function sealRaw(side: PeerSide, connId: string, kind: PeerEnvelopeKind, seq: number, plaintext: string): PeerEnvelope {
  return side.run(() => {
    const id = loadPeerIdentity();
    const { sendKey, connTag } = peerConnectionKeys(getPeerConnection(connId)!);
    const nonce = randomBytes(12);
    const header = { v: 1 as const, conn: connTag, from: id.fingerprint, seq, sent_at: Date.now(), kind, nonce: b64u(nonce) };
    const ct = b64u(aesGcmSeal(sendKey, Buffer.from(plaintext), Buffer.from(peerEnvelopeHeaderString(header)), nonce).ct);
    return { ...header, ct, sig: b64u(ed25519Sign(id.privateKey, Buffer.from(`${peerEnvelopeHeaderString(header)}\n${ct}`))) };
  });
}

/** Both people confirm; the connection turns active, and only then does each side grant the other the right to send. */
function activate(p: Paired): void {
  const sides = [[p.a, p.aConn, p.b, p.bConn], [p.b, p.bConn, p.a, p.aConn]] as const;
  for (const [side, conn] of sides) side.run(() => { recordPeerConfirmation(conn, "mine"); queueOutgoing(conn, "confirm", {}); });
  for (const [side, conn, other, otherConn] of sides) pump(side, conn, other, otherConn);
  for (const [side, conn] of sides) side.run(() => {
    // The inbox recorded the other side's confirm as it stored it.
    expect(getPeerConnection(conn)!.status).toBe("active");
    for (const m of pendingIncoming(conn)) if (m.kind === "confirm") setIncomingState(m.id, ["received"], "delivered_to_chat");
    queueOutgoing(conn, "grant", { transport: "tailscale", inbound_token: randomToken() });
  });
  for (const [side, conn, other, otherConn] of sides) pump(side, conn, other, otherConn);
  for (const [side, conn] of sides) side.run(() => {
    const grant = pendingIncoming(conn).find((m) => m.kind === "grant")!;
    expect(readIncomingBody<"grant">(grant.id)).toMatchObject({ transport: "tailscale" });
    setIncomingState(grant.id, ["received"], "delivered_to_chat");
  });
}

const texts = (side: PeerSide, conn: string) => side.run(() => pendingIncoming(conn).filter((m) => m.kind === "msg").map((m) => (readIncomingBody<"msg">(m.id) as { text: string }).text));
const sendSeqOf = (p: Paired) => p.a.run(() => getPeerConnection(p.aConn)!.send_seq);

let current: Paired;

describe("pairing", () => {
  it("both sides show the same six digits and become active only after both confirm", () => {
    current = pair();
    expect(current.sasA).toMatch(/^\d{6}$/);
    expect(current.sasA).toBe(current.sasB);
    current.a.run(() => {
      expect(nextOutgoingEnvelope(current.aConn)).toBeNull(); // nothing queued
      queueOutgoing(current.aConn, "msg", { text: "too early" });
      queueOutgoing(current.aConn, "grant", { transport: "tailscale", inbound_token: randomToken() });
      expect(nextOutgoingEnvelope(current.aConn)).toBeNull(); // pending: only confirm may go
      getDb().query("DELETE FROM peer_messages WHERE kind = 'grant'").run();
      expect(recordPeerConfirmation(current.aConn, "mine")).toBe("pending_confirm");
    });
    activate(current);
    expect(current.a.run(() => getPeerConnection(current.aConn)!.status)).toBe("active");
    expect(current.b.run(() => getPeerConnection(current.bConn)!.status)).toBe("active");
  });

  it("the invite opens the pairing door once, and only with its secret", () => {
    const p = pair();
    p.a.run(() => {
      const id = b64u(decodeInvite(p.inviteCode).inviteId);
      expect(claimPeerInvite(id, p.pairSecret)).toEqual({ ok: false, reason: "used" });
      expect(claimPeerInvite(id, randomToken())).toEqual({ ok: false, reason: "bad_secret" });
      expect(claimPeerInvite("nope", p.pairSecret)).toEqual({ ok: false, reason: "unknown" });
    });
  });

  it("refuses ordered messages other than confirm while the digits are unconfirmed", () => {
    const p = pair();
    const env = sealRaw(p.a, p.aConn, "msg", 1, JSON.stringify({ text: "before anyone compared digits" }));
    expect(p.b.run(() => receivePeerEnvelope(getPeerConnection(p.bConn)!, wire(env)))).toEqual({ result: "rejected", reason: "not_confirmed" });
    expect(p.b.run(() => getPeerConnection(p.bConn)!.recv_seq)).toBe(0);
  });

  it("keeps no secret in the database in the clear", () => {
    const p = current;
    p.a.run(() => storePeerSecret(p.aConn, "outbound_token_enc", "tok-SECRET-123"));
    p.a.run(() => {
      const dump = JSON.stringify(["peer_connections", "peer_invites", "peer_messages", "peer_relay_mailboxes"].map((t) => getDb().query(`SELECT * FROM ${t}`).all()));
      for (const secret of ["tok-SECRET-123", p.pairSecret, p.inviteCode, b64u(p.root), p.root.toString("hex"), p.root.toString("base64")]) {
        expect(dump).not.toContain(secret);
      }
      expect(readPeerSecret(getPeerConnection(p.aConn)!, "outbound_token_enc")).toBe("tok-SECRET-123");
    });
  });
});

describe("delivery", () => {
  it("delivers in order, one in flight at a time, and a lost answer is resent as the same bytes", () => {
    const { a, b, aConn, bConn } = current;
    a.run(() => { queueOutgoing(aConn, "msg", { text: "một" }); queueOutgoing(aConn, "msg", { text: "hai" }); });
    const first = a.run(() => nextOutgoingEnvelope(aConn))!;
    expect(a.run(() => nextOutgoingEnvelope(aConn))!.envelope.sig).toBe(first.envelope.sig);
    expect(pump(a, aConn, b, bConn, { dropReply: true })).toEqual(["accepted"]);
    // The answer was lost: the resend is the same envelope, and the receiver calls it a success.
    expect(pump(a, aConn, b, bConn)).toEqual(["duplicate", "accepted"]);
    expect(texts(b, bConn)).toEqual(["too early", "một", "hai"]);
  });

  it("refuses a changed envelope, and one replayed onto another connection", () => {
    const { a, b, aConn, bConn } = current;
    a.run(() => queueOutgoing(aConn, "msg", { text: "ba" }));
    const out = a.run(() => nextOutgoingEnvelope(aConn))!;
    const r = b.run(() => receivePeerEnvelope(getPeerConnection(bConn)!, { ...wire(out.envelope), seq: out.envelope.seq + 1 }));
    expect(r).toEqual({ result: "rejected", reason: "bad_signature" });
    // A second connection between the same two machines: same identities, different tag.
    const second = pair({ a, b });
    expect(b.run(() => receivePeerEnvelope(getPeerConnection(second.bConn)!, wire(out.envelope)))).toEqual({ result: "rejected", reason: "wrong_connection" });
    pump(a, aConn, b, bConn);
  });

  it("still delivers a message sealed more than a week ago", () => {
    const { a, b, aConn, bConn } = current;
    a.run(() => queueOutgoing(aConn, "msg", { text: "trước chuyến đi" }));
    a.run(() => nextOutgoingEnvelope(aConn, Date.now() - 10 * DAY));
    expect(pump(a, aConn, b, bConn)).toEqual(["accepted"]);
    expect(texts(b, bConn).at(-1)).toBe("trước chuyến đi");
  });

  it("recovers when the receiver's database goes back, by resending what it lacks", () => {
    const { a, b, aConn, bConn } = current;
    b.run(() => {
      getDb().query("DELETE FROM peer_messages WHERE connection_id = ? AND direction = 'in' AND seq > 2").run(bConn);
      getDb().query("UPDATE peer_connections SET recv_seq = 2 WHERE id = ?").run(bConn);
    });
    a.run(() => queueOutgoing(aConn, "msg", { text: "bốn" }));
    const results = pump(a, aConn, b, bConn);
    expect(results[0]).toBe("nack");
    expect(texts(b, bConn).slice(-4)).toEqual(["hai", "ba", "trước chuyến đi", "bốn"]);
  });

  it("moves forward when the sender's database goes back, without overwriting what the receiver holds", () => {
    const { a, b, aConn, bConn } = current;
    const before = b.run(() => getPeerConnection(bConn)!.recv_seq);
    a.run(() => {
      getDb().query("DELETE FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq > 2").run(aConn);
      getDb().query("UPDATE peer_connections SET send_seq = 2 WHERE id = ?").run(aConn);
      queueOutgoing(aConn, "msg", { text: "năm" });
    });
    expect(pump(a, aConn, b, bConn)).toEqual(["nack", "accepted"]);
    expect(b.run(() => getPeerConnection(bConn)!.recv_seq)).toBe(before + 1);
    expect(texts(b, bConn).at(-1)).toBe("năm");
  });

  it("an old ack replayed after the sender's database went back marks nothing delivered", () => {
    const { a, b, aConn, bConn } = current;
    const replies: PeerEnvelope[] = [];
    a.run(() => queueOutgoing(aConn, "msg", { text: "bảy" }));
    pump(a, aConn, b, bConn, { replies });
    const oldAck = replies.at(-1)!;
    const s = sendSeqOf(current);
    a.run(() => {
      getDb().query("DELETE FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq >= ?").run(aConn, s);
      getDb().query("UPDATE peer_connections SET send_seq = ? WHERE id = ?").run(s - 1, aConn);
      queueOutgoing(aConn, "msg", { text: "tám" });
    });
    const x = a.run(() => nextOutgoingEnvelope(aConn))!;
    expect(x.seq).toBe(s);
    const r = a.run(() => receivePeerEnvelope(getPeerConnection(aConn)!, wire(oldAck)));
    expect(r.result === "control" && r.ack).toEqual({ applied: 0, ignored: "unknown_envelope" });
    expect(a.run(() => outgoingStatus(x.messageId))).toBe("in_flight");
    expect(pump(a, aConn, b, bConn)).toEqual(["nack", "accepted"]);
    expect(texts(b, bConn).slice(-2)).toEqual(["bảy", "tám"]);
  });

  it("a delayed copy of an envelope from before a renumbering does not deliver anything twice", () => {
    const { a, b, aConn, bConn } = current;
    const s = sendSeqOf(current);
    a.run(() => {
      getDb().query("DELETE FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq >= ?").run(aConn, s - 1);
      getDb().query("UPDATE peer_connections SET send_seq = ? WHERE id = ?").run(s - 2, aConn);
      queueOutgoing(aConn, "msg", { text: "chín" });
    });
    const stale = a.run(() => nextOutgoingEnvelope(aConn))!.envelope; // the copy a slow network will deliver later
    expect(pump(a, aConn, b, bConn)).toEqual(["nack", "accepted"]); // renumbered, then delivered
    a.run(() => queueOutgoing(aConn, "msg", { text: "mười" }));
    expect(pump(a, aConn, b, bConn, { dropReply: true })).toEqual(["accepted"]); // its ack is lost
    const late = b.run(() => receivePeerEnvelope(getPeerConnection(bConn)!, wire(stale)));
    expect(late.result).toBe("nack");
    const plan = a.run(() => receivePeerEnvelope(getPeerConnection(aConn)!, wire((late as { reply: PeerEnvelope }).reply)));
    expect(plan.result === "control" && plan.nack?.action).toBe("ignore");
    expect(pump(a, aConn, b, bConn)).toEqual(["duplicate"]);
    expect(texts(b, bConn).filter((t) => t === "mười")).toHaveLength(1);
    expect(texts(b, bConn).filter((t) => t === "chín")).toHaveLength(1);
  });

  it("declares a gap the sender can no longer fill, and both sides move past it", () => {
    const { a, b, aConn, bConn } = current;
    const sendSeq = sendSeqOf(current);
    b.run(() => {
      getDb().query("DELETE FROM peer_messages WHERE connection_id = ? AND direction = 'in' AND seq > 1").run(bConn);
      getDb().query("UPDATE peer_connections SET recv_seq = 1 WHERE id = ?").run(bConn);
    });
    a.run(() => {
      getDb().query("DELETE FROM peer_messages WHERE connection_id = ? AND direction = 'out' AND seq < ?").run(aConn, sendSeq);
      queueOutgoing(aConn, "msg", { text: "sáu" });
    });
    const results = pump(a, aConn, b, bConn);
    expect(results[0]).toBe("nack");
    expect(results[1]).toBe(`resync:${sendSeq - 2}`);
    expect(texts(b, bConn).slice(-2)).toEqual(["mười", "sáu"]);
    expect(b.run(() => getPeerConnection(bConn)!.recv_seq)).toBe(sendSeqOf(current));
  });

  it("answers a stale nack without delivering anything twice", () => {
    const { a, b, aConn, bConn } = current;
    const n = texts(b, bConn).length;
    const plan = a.run(() => applyNack(aConn, { expected_seq: 1 }));
    expect(plan.action === "resend" || plan.action === "resync").toBe(true);
    pump(a, aConn, b, bConn);
    expect(texts(b, bConn).length).toBe(n);
    expect(a.run(() => applyNack(aConn, { expected_seq: sendSeqOf(current) + 5 }))).toEqual({ action: "ignore" });
  });
});

describe("queue edges", () => {
  it("refuses at queue time a message that could never be sealed", () => {
    const { a, aConn } = current;
    a.run(() => {
      expect(() => queueOutgoing(aConn, "msg", { text: "x".repeat(50 * 1024) })).toThrow(PeerEnvelopeTooLargeError);
      expect(() => queueOutgoing(aConn, "grant", { transport: "tailscale", inbound_token: "not base64!" })).toThrow();
    });
  });

  it("withdraws a queued message, but not one already sealed", () => {
    const { a, aConn } = current;
    a.run(() => {
      const first = queueOutgoing(aConn, "msg", { text: "đã niêm phong" });
      const second = queueOutgoing(aConn, "msg", { text: "còn trong hàng" });
      nextOutgoingEnvelope(aConn);
      expect(cancelOutgoing(first)).toBe(false);
      expect(cancelOutgoing(second)).toBe(true);
      expect(outgoingStatus(second)).toBe("failed");
    });
    pump(current.a, current.aConn, current.b, current.bConn);
    expect(texts(current.b, current.bConn).at(-1)).toBe("đã niêm phong");
  });

  it("drops a body it cannot read, moves on, and tells the sender", () => {
    const { a, b, aConn, bConn } = current;
    const seq = sendSeqOf(current) + 1;
    a.run(() => getDb().query("UPDATE peer_connections SET send_seq = ? WHERE id = ?").run(seq, aConn));
    const env = sealRaw(a, aConn, "msg", seq, JSON.stringify({ text: "x", request: { kind: "video_call" } }));
    const r = b.run(() => receivePeerEnvelope(getPeerConnection(bConn)!, wire(env)));
    expect(r.result).toBe("refused");
    expect(b.run(() => getPeerConnection(bConn)!.recv_seq)).toBe(seq);
    const back = a.run(() => receivePeerEnvelope(getPeerConnection(aConn)!, wire((r as { reply: PeerEnvelope }).reply)));
    expect(back.result === "control" && (back.body as { refused?: boolean }).refused).toBe(true);
    a.run(() => queueOutgoing(aConn, "msg", { text: "sau tin lạ" }));
    expect(pump(a, aConn, b, bConn)).toEqual(["accepted"]);
  });
});

describe("clean-up", () => {
  it("drops connections never confirmed after a day, and keeps active ones", () => {
    const p = pair();
    const later = Date.now() + 25 * 60 * 60 * 1000;
    const res = p.a.run(() => prunePeerState(later));
    expect(res.removedPending.map((c) => c.id)).toEqual([p.aConn]);
    current.a.run(() => {
      expect(prunePeerState(later).removedPending.map((c) => c.id)).not.toContain(current.aConn);
      expect(getPeerConnection(current.aConn)!.status).toBe("active");
    });
  });
});
