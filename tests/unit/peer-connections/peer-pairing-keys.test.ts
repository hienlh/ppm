import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { generateEd25519, generateX25519, x25519 } from "../../../src/services/peer-connections/peer-crypto.ts";
import {
  checkReveal, commitmentOf, completePairing, derivePairingKeys, newCommitNonce, shortAuthString, type PairingPublics,
} from "../../../src/services/peer-connections/peer-pairing-keys.ts";

/** A copy of `buf` with one bit changed at `index`. */
const flipByte = (buf: Uint8Array, index: number): Buffer => { const c = Buffer.from(buf); c.writeUInt8(c.readUInt8(index) ^ 1, index); return c; };

function setup() {
  const inviterId = generateEd25519();
  const acceptorId = generateEd25519();
  const inviterEph = generateX25519();
  const acceptorEph = generateX25519();
  const nonce = newCommitNonce();
  const publics: PairingPublics = {
    inviteId: randomBytes(16), inviterIdentity: inviterId.publicKey, inviterEphemeral: inviterEph.publicKey,
    acceptorIdentity: acceptorId.publicKey, acceptorEphemeral: acceptorEph.publicKey, commitment: commitmentOf(nonce),
  };
  return { inviterEph, acceptorEph, nonce, publics };
}

describe("pairing key schedule", () => {
  it("gives both sides the same root, tag, direction keys and digits", () => {
    const { inviterEph, acceptorEph, nonce, publics } = setup();
    const a = completePairing({ myEphemeralPrivate: inviterEph.privateKey, theirEphemeralPublic: acceptorEph.publicKey }, nonce, publics);
    const b = completePairing({ myEphemeralPrivate: acceptorEph.privateKey, theirEphemeralPublic: inviterEph.publicKey }, nonce, publics);
    expect(a.root.equals(b.root)).toBe(true);
    expect(a.connTag.equals(b.connTag)).toBe(true);
    expect(a.kAb.equals(b.kAb) && a.kBa.equals(b.kBa)).toBe(true);
    expect(a.kAb.equals(a.kBa)).toBe(false);
    expect(a.sas).toMatch(/^\d{6}$/);
    expect(a.sas).toBe(b.sas);
  });

  it("the keys needed to carry the reveal do not depend on the commitment nonce", () => {
    const { inviterEph, acceptorEph, publics } = setup();
    const shared = x25519(acceptorEph.privateKey, inviterEph.publicKey);
    const before = derivePairingKeys(shared, publics);
    expect(before.root.length).toBe(32);
  });

  it("changing any byte of the transcript changes the digits", () => {
    const { inviterEph, acceptorEph, nonce, publics } = setup();
    const shared = x25519(inviterEph.privateKey, acceptorEph.publicKey);
    const base = shortAuthString(shared, nonce, publics);
    const fields: Array<keyof PairingPublics> = ["inviteId", "inviterIdentity", "inviterEphemeral", "acceptorIdentity", "acceptorEphemeral", "commitment"];
    let changed = 0;
    for (const f of fields) {
      for (const pos of [0, publics[f].length - 1]) {
        const copy = flipByte(publics[f], pos);
        // A collision on 10^6 values is possible in principle; the root key must differ regardless.
        const sas = shortAuthString(shared, nonce, { ...publics, [f]: copy });
        const root = derivePairingKeys(shared, { ...publics, [f]: copy }).root;
        expect(root.equals(derivePairingKeys(shared, publics).root)).toBe(false);
        if (sas !== base) changed++;
      }
    }
    expect(changed).toBeGreaterThanOrEqual(11);
  });

  it("refuses a reveal that does not open the commitment", () => {
    const { inviterEph, acceptorEph, publics } = setup();
    const wrong = newCommitNonce();
    expect(checkReveal(wrong, publics.commitment)).toBe(false);
    expect(() => completePairing({ myEphemeralPrivate: acceptorEph.privateKey, theirEphemeralPublic: inviterEph.publicKey }, wrong, publics)).toThrow();
  });

  /**
   * A man in the middle facing the acceptor must pick his ephemeral key before he knows the
   * inviter's nonce. Grinding thousands of keys for one whose digits match the other screen, under
   * any nonce he can guess, gives him nothing once the real nonce is revealed.
   */
  it("grinding ephemeral keys before the reveal does not produce matching digits", () => {
    const victimSas = "123456";
    const inviterId = generateEd25519();
    const realNonce = newCommitNonce();
    const commitment = commitmentOf(realNonce);
    const acceptorEph = generateX25519();
    const inviteId = randomBytes(16);
    const guessedNonce = Buffer.alloc(32);
    let matchedUnderGuess = 0;
    let stillMatchingForReal = 0;
    for (let i = 0; i < 3000; i++) {
      const mallory = generateX25519();
      const publics: PairingPublics = {
        inviteId, inviterIdentity: inviterId.publicKey, inviterEphemeral: mallory.publicKey,
        acceptorIdentity: generateEd25519().publicKey, acceptorEphemeral: acceptorEph.publicKey, commitment,
      };
      const shared = x25519(mallory.privateKey, acceptorEph.publicKey);
      // Scored on the last digit only (a 10% hit rate) so the test stays fast; a full six-digit
      // search is the same experiment a million times longer.
      if (shortAuthString(shared, guessedNonce, publics).endsWith(victimSas.slice(-1))) {
        matchedUnderGuess++;
        if (shortAuthString(shared, realNonce, publics).endsWith(victimSas.slice(-1))) stillMatchingForReal++;
      }
    }
    // ~300 keys looked right under the guess; with the real nonce they match no more often than
    // chance (10%, i.e. ~30 of them). 25% is more than four standard deviations above that.
    expect(matchedUnderGuess).toBeGreaterThan(150);
    expect(stillMatchingForReal / matchedUnderGuess).toBeLessThan(0.25);
  });
});
