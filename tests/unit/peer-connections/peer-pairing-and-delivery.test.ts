/**
 * Two PPMs, each with its own database and keys, pair through an invite and then exchange
 * messages through the outbox and inbox. The "network" is a function call that hands the sealed
 * envelope across, so lost answers, restored databases and pruned history can be staged exactly.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { getDb } from "../../../src/services/db.service.ts";
import { PEER_PRESET_DEFAULTS } from "../../../src/shared/peer-connections.ts";
import { parsePeerEnvelope, serializePeerEnvelope, type PeerEnvelope } from "../../../src/shared/peer-envelope.ts";
import { b64u, fingerprintOf, fromB64u, generateX25519, randomToken, x25519 } from "../../../src/services/peer-connections/peer-crypto.ts";
import { checkReveal, commitmentOf, derivePairingKeys, newCommitNonce, shortAuthString, type PairingPublics } from "../../../src/services/peer-connections/peer-pairing-keys.ts";
import { decodeAccept, decodeInvite, encodeAccept, encodeInvite } from "../../../src/services/peer-connections/peer-invite-code.ts";
import { loadPeerIdentity } from "../../../src/services/peer-connections/peer-identity.ts";
import { claimPeerInvite, insertPeerInvite, linkPeerInviteConnection, prunePeerState } from "../../../src/services/peer-connections/peer-invites-db.ts";
import {
  getPeerConnection, getPeerConnectionByTag, insertPeerConnection, readPeerSecret, recordPeerConfirmation, storePeerSecret,
} from "../../../src/services/peer-connections/peer-connections-db.ts";
import { applyNack, nextOutgoingEnvelope, queueOutgoing } from "../../../src/services/peer-connections/peer-outbox-db.ts";
import { pendingIncoming, readIncomingBody, receivePeerEnvelope, sealControl, setIncomingState } from "../../../src/services/peer-connections/peer-inbox-db.ts";
import { leavePeerSides, makePeerSide, type PeerSide } from "./two-peer-sides.ts";

afterAll(leavePeerSides);

const wire = (env: PeerEnvelope) => parsePeerEnvelope(serializePeerEnvelope(env));

interface Paired { a: PeerSide; b: PeerSide; aConn: string; bConn: string; sasA: string; sasB: string; inviteCode: string; pairSecret: string }

function pair(): Paired {
  const a = makePeerSide("inviter");
  const b = makePeerSide("acceptor");
  const pairSecret = randomToken();
  // Inviter: issue the code.
  const code = a.run(() => {
    const id = loadPeerIdentity();
    const eph = generateX25519();
    const nonce = newCommitNonce();
    const inviteId = randomBytes(16);
    const invite = { inviteId, inviterEphemeral: eph.publicKey, inviterIdentity: id.publicKey, commitment: commitmentOf(nonce), pairSecret, hint: { tailscale: { host: "a.tail.ts.net" } }, label: "Máy A", expiresAt: Date.now() + 15 * 60_000 };
    const code = encodeInvite(invite, id.privateKey);
    insertPeerInvite({ inviteId, code, ephemeralPrivate: eph.privateKey, commitNonce: nonce, commitment: invite.commitment, pairSecret, pairMailboxId: null, label: "Máy B", transport: "tailscale", preset: "mine", expiresAt: invite.expiresAt, createdBy: "user" });
    return code;
  });
  // Acceptor: read the code, answer with an accept, store its half.
  const { acceptText, bConn, acceptorEph, invite } = b.run(() => {
    const invite = decodeInvite(code);
    const id = loadPeerIdentity();
    const eph = generateX25519();
    const acceptText = encodeAccept({ inviteId: invite.inviteId, acceptorEphemeral: eph.publicKey, acceptorIdentity: id.publicKey, pairSecret: invite.pairSecret, claimedName: "laptop", sentAt: Date.now() }, id.privateKey);
    const publics: PairingPublics = { inviteId: invite.inviteId, inviterIdentity: invite.inviterIdentity, inviterEphemeral: invite.inviterEphemeral, acceptorIdentity: id.publicKey, acceptorEphemeral: eph.publicKey, commitment: invite.commitment };
    const keys = derivePairingKeys(x25519(eph.privateKey, invite.inviterEphemeral), publics);
    const row = insertPeerConnection({ label: "Máy A", peerClaimedName: "", peerFingerprint: fingerprintOf(invite.inviterIdentity), peerIdentityPublic: invite.inviterIdentity, myRole: "acceptor", root: keys.root, transport: "tailscale", inviteAcceptedBy: "user", settings: PEER_PRESET_DEFAULTS.mine, tailscaleHost: "a.tail.ts.net" });
    return { acceptText, bConn: row.id, acceptorEph: eph, invite };
  });
  // Inviter: take the accept through the pairing door, derive keys, reveal the nonce.
  const { aConn, sasA, reveal } = a.run(() => {
    const acc = decodeAccept(acceptText);
    const claim = claimPeerInvite(b64u(acc.inviteId), acc.pairSecret);
    if (!claim.ok) throw new Error(claim.reason);
    const id = loadPeerIdentity();
    const publics: PairingPublics = { inviteId: acc.inviteId, inviterIdentity: id.publicKey, inviterEphemeral: invite.inviterEphemeral, acceptorIdentity: acc.acceptorIdentity, acceptorEphemeral: acc.acceptorEphemeral, commitment: invite.commitment };
    const shared = x25519(claim.invite.ephemeralPrivate, acc.acceptorEphemeral);
    const keys = derivePairingKeys(shared, publics);
    const row = insertPeerConnection({ label: "Máy B", peerClaimedName: acc.claimedName, peerFingerprint: fingerprintOf(acc.acceptorIdentity), peerIdentityPublic: acc.acceptorIdentity, myRole: "inviter", root: keys.root, transport: "tailscale", inviteAcceptedBy: null, settings: PEER_PRESET_DEFAULTS.mine });
    linkPeerInviteConnection(b64u(acc.inviteId), row.id);
    return { aConn: row.id, sasA: shortAuthString(shared, claim.invite.commitNonce, publics), reveal: sealControl(row, "reveal", { nonce: b64u(claim.invite.commitNonce) }) };
  });
  // Acceptor: open the commitment and compute the digits.
  const sasB = b.run(() => {
    const conn = getPeerConnectionByTag(reveal.conn)!;
    const r = receivePeerEnvelope(conn, wire(reveal));
    if (r.result !== "control" || r.kind !== "reveal") throw new Error("reveal not received");
    const nonce = fromB64u((r.body as { nonce: string }).nonce, 32);
    expect(checkReveal(nonce, invite.commitment)).toBe(true);
    const id = loadPeerIdentity();
    const publics: PairingPublics = { inviteId: invite.inviteId, inviterIdentity: invite.inviterIdentity, inviterEphemeral: invite.inviterEphemeral, acceptorIdentity: id.publicKey, acceptorEphemeral: acceptorEph.publicKey, commitment: invite.commitment };
    return shortAuthString(x25519(acceptorEph.privateKey, invite.inviterEphemeral), nonce, publics);
  });
  return { a, b, aConn, bConn, sasA, sasB, inviteCode: code, pairSecret };
}


/** Send everything `from` has ready to `to`, one in flight at a time, answering each with its reply. */
function pump(from: PeerSide, fromConn: string, to: PeerSide, toConn: string, opts: { dropReply?: boolean } = {}): string[] {
  const results: string[] = [];
  for (let i = 0; i < 20; i++) {
    const out = from.run(() => nextOutgoingEnvelope(fromConn));
    if (!out) break;
    const r = to.run(() => receivePeerEnvelope(getPeerConnectionByTag(out.envelope.conn)!, wire(out.envelope)));
    results.push(r.result);
    if (r.result === "rejected" || opts.dropReply || !("reply" in r) || !r.reply) break;
    const back = from.run(() => receivePeerEnvelope(getPeerConnection(fromConn)!, wire(r.reply!)));
    if (back.result === "control" && back.kind === "nack") {
      const plan = back.nack!;
      if (plan.action === "resync") {
        const env = from.run(() => sealControl(getPeerConnection(fromConn)!, "resync", { next_seq: plan.nextSeq }));
        const rr = to.run(() => receivePeerEnvelope(getPeerConnection(toConn)!, wire(env)));
        results.push(`resync:${rr.result === "control" ? rr.resyncLost : "?"}`);
      }
    }
  }
  return results;
}

let current: Paired;

/** Both people confirm; the connection turns active, and only then does each side grant the other the right to send. */
function activate(p: Paired): void {
  const sides = [[p.a, p.aConn, p.b, p.bConn], [p.b, p.bConn, p.a, p.aConn]] as const;
  for (const [side, conn] of sides) side.run(() => { recordPeerConfirmation(conn, "mine"); queueOutgoing(conn, "confirm", {}); });
  for (const [side, conn, other, otherConn] of sides) pump(side, conn, other, otherConn);
  for (const [side, conn] of sides) side.run(() => {
    for (const m of pendingIncoming(conn)) if (m.kind === "confirm") {
      recordPeerConfirmation(conn, "peer");
      setIncomingState(m.id, ["received"], "delivered_to_chat");
    }
    expect(getPeerConnection(conn)!.status).toBe("active");
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

  it("keeps no secret in the database in the clear", () => {
    const p = current;
    p.a.run(() => storePeerSecret(p.aConn, "outbound_token_enc", "tok-SECRET-123"));
    p.a.run(() => {
      const dump = JSON.stringify(["peer_connections", "peer_invites", "peer_messages"].map((t) => getDb().query(`SELECT * FROM ${t}`).all()));
      expect(dump).not.toContain("tok-SECRET-123");
      expect(dump).not.toContain(p.pairSecret);
      expect(dump).not.toContain(p.inviteCode);
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

  it("refuses a changed envelope and one replayed onto another connection", () => {
    const { a, b, aConn, bConn } = current;
    a.run(() => queueOutgoing(aConn, "msg", { text: "ba" }));
    const out = a.run(() => nextOutgoingEnvelope(aConn))!;
    const r = b.run(() => receivePeerEnvelope(getPeerConnectionByTag(out.envelope.conn)!, { ...wire(out.envelope), seq: out.envelope.seq + 1 }));
    expect(r).toEqual({ result: "rejected", reason: "bad_signature" });
    const other = pair();
    const r2 = other.b.run(() => receivePeerEnvelope(getPeerConnection(other.bConn)!, wire(out.envelope)));
    expect(r2.result).toBe("rejected");
    pump(a, aConn, b, bConn);
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
    expect(texts(b, bConn).slice(-3)).toEqual(["hai", "ba", "bốn"]);
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

  it("declares a gap the sender can no longer fill, and both sides move past it", () => {
    const { a, b, aConn, bConn } = current;
    const sendSeq = a.run(() => getPeerConnection(aConn)!.send_seq);
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
    expect(texts(b, bConn).slice(-2)).toEqual(["năm", "sáu"]);
    expect(b.run(() => getPeerConnection(bConn)!.recv_seq)).toBe(a.run(() => getPeerConnection(aConn)!.send_seq));
  });

  it("acknowledges a stale nack without duplicating anything", () => {
    const { a, b, aConn, bConn } = current;
    const n = texts(b, bConn).length;
    const plan = a.run(() => applyNack(aConn, 1));
    expect(plan.action === "resend" || plan.action === "resync").toBe(true);
    pump(a, aConn, b, bConn);
    expect(texts(b, bConn).length).toBe(n);
  });
});

describe("clean-up", () => {
  it("drops connections never confirmed after a day, and keeps active ones", () => {
    const p = pair();
    const later = Date.now() + 25 * 60 * 60 * 1000;
    const res = p.a.run(() => prunePeerState(later));
    expect(res.removedPending.map((c) => c.id)).toEqual([p.aConn]);
    expect(current.a.run(() => prunePeerState(later).removedPending)).toEqual([]);
  });
});
