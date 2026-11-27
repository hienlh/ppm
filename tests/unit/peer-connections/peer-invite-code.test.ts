import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { generateEd25519, generateX25519, randomToken } from "../../../src/services/peer-connections/peer-crypto.ts";
import { commitmentOf, newCommitNonce } from "../../../src/services/peer-connections/peer-pairing-keys.ts";
import {
  decodeAccept, decodeInvite, encodeAccept, encodeInvite, INVITE_PREFIX, inviteCodeHash, type PeerInvite,
} from "../../../src/services/peer-connections/peer-invite-code.ts";

const inviter = generateEd25519();
const now = 1_800_000_000_000;

function invite(over: Partial<PeerInvite> = {}): PeerInvite {
  return {
    inviteId: randomBytes(16), inviterEphemeral: generateX25519().publicKey, inviterIdentity: inviter.publicKey,
    commitment: commitmentOf(newCommitNonce()), pairSecret: randomToken(), hint: { tailscale: { host: "laptop.tail1234.ts.net" } },
    label: "Laptop\nnhà", expiresAt: now + 15 * 60_000, ...over,
  };
}

describe("invite code", () => {
  it("round-trips, with whitespace from a paste ignored and control characters removed from the label", () => {
    const inv = invite({ hint: { relay: { url: "https://relay.example", mailbox: "mb_1" } } });
    const code = encodeInvite(inv, inviter.privateKey);
    expect(code.startsWith(INVITE_PREFIX)).toBe(true);
    const back = decodeInvite(`  ${code}\n`, now);
    expect(back.inviteId.equals(inv.inviteId)).toBe(true);
    expect(back.commitment.equals(inv.commitment)).toBe(true);
    expect(back.hint).toEqual({ relay: { url: "https://relay.example", mailbox: "mb_1" } });
    expect(back.label).toBe("Laptop nhà");
    expect(back.pairSecret).toBe(inv.pairSecret);
  });

  it("refuses an expired code, a code signed by another key, and a damaged one", () => {
    const code = encodeInvite(invite(), inviter.privateKey);
    expect(() => decodeInvite(code, now + 16 * 60_000)).toThrow(/expired/);
    const other = generateEd25519();
    expect(() => decodeInvite(encodeInvite(invite(), other.privateKey), now)).toThrow(/signature/);
    const json = JSON.parse(Buffer.from(code.slice(INVITE_PREFIX.length), "base64url").toString());
    json.label = "Kẻ lạ";
    expect(() => decodeInvite(INVITE_PREFIX + Buffer.from(JSON.stringify(json)).toString("base64url"), now)).toThrow(/signature/);
    expect(() => decodeInvite(code.slice(0, -5), now)).toThrow();
    expect(() => decodeInvite("hello", now)).toThrow(/not a PPM/);
  });

  it("refuses hints that are not an https relay or a tailnet host name", () => {
    expect(() => encodeInvite(invite({ hint: { relay: { url: "http://relay.example", mailbox: "m" } } }), inviter.privateKey)).toThrow();
    expect(() => encodeInvite(invite({ hint: { tailscale: { host: "a b" } } }), inviter.privateKey)).toThrow();
  });
});

describe("accept", () => {
  it("round-trips and is bound to the acceptor's identity", () => {
    const acceptor = generateEd25519();
    const a = { inviteId: randomBytes(16), acceptorEphemeral: generateX25519().publicKey, acceptorIdentity: acceptor.publicKey, pairSecret: randomToken(), claimedName: "Máy\tcông ty", sentAt: now };
    const code = encodeInvite(invite({ inviteId: a.inviteId }), inviter.privateKey);
    const text = encodeAccept(a, code, acceptor.privateKey);
    const lookup = (id: string) => (id === Buffer.from(a.inviteId).toString("base64url") ? inviteCodeHash(code) : null);
    const back = decodeAccept(text, lookup);
    expect(back.claimedName).toBe("Máy công ty");
    expect(back.pairSecret).toBe(a.pairSecret);
    const forged = JSON.parse(text);
    forged.ae = Buffer.from(generateX25519().publicKey).toString("base64url");
    expect(() => decodeAccept(JSON.stringify(forged), lookup)).toThrow(/signature/);
    // Signed for another invite with the same id (a swapped code): refused.
    const otherCode = encodeInvite(invite({ inviteId: a.inviteId }), inviter.privateKey);
    expect(() => decodeAccept(text, () => inviteCodeHash(otherCode))).toThrow(/signature/);
    expect(() => decodeAccept(text, () => null)).toThrow(/no such invite/);
  });
});
