/**
 * The vault's crypto in isolation: a data key wrapped per tier, items bound to their tier and id
 * by the additional data, and every kind of tampering failing closed rather than throwing.
 */
import { describe, expect, it } from "bun:test";
import {
  decryptItem, deriveKek, encryptItem, newDek, newSalt, parseKdfParams, unwrapDek, wrapDek,
} from "../../../../src/services/vault/vault-crypto.ts";

const FAST = { N: 1024, r: 8, p: 1 };

describe("vault-crypto", () => {
  it("wraps and unwraps a data key; a wrong password gives null, not a throw", async () => {
    const salt = newSalt();
    const dek = newDek();
    const kek = await deriveKek("correct horse battery", salt, FAST);
    const { nonce, wrapped } = wrapDek(kek, dek, "secure");
    const again = await deriveKek("correct horse battery", salt, FAST);
    expect(unwrapDek(again, nonce, wrapped, "secure")?.equals(dek)).toBe(true);
    const wrong = await deriveKek("correct horse batterx", salt, FAST);
    expect(unwrapDek(wrong, nonce, wrapped, "secure")).toBeNull();
    // A key wrapped for one tier does not unwrap as the other.
    expect(unwrapDek(again, nonce, wrapped, "sealed")).toBeNull();
  });

  it("derives the same key for the same password typed in another Unicode form", async () => {
    const salt = newSalt();
    const composed = await deriveKek("mật khẩu dài dài", salt, FAST);
    const decomposed = await deriveKek("mật khẩu dài dài".normalize("NFD"), salt, FAST);
    expect(composed.equals(decomposed)).toBe(true);
  });

  it("round-trips an item and fails on any tampered byte, swapped id or moved tier", () => {
    const dek = newDek();
    const { nonce, ciphertext } = encryptItem(dek, "sealed", "item-a", { value: "QQ123456C", note: "mine" });
    expect(decryptItem(dek, "sealed", "item-a", nonce, ciphertext)).toEqual({ value: "QQ123456C", note: "mine" });

    const flipped = Buffer.from(ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(decryptItem(dek, "sealed", "item-a", nonce, flipped)).toBeNull();
    const badTag = Buffer.from(ciphertext);
    badTag[badTag.length - 1] = badTag[badTag.length - 1]! ^ 1;
    expect(decryptItem(dek, "sealed", "item-a", nonce, badTag)).toBeNull();
    const badNonce = Buffer.from(nonce);
    badNonce[0] = badNonce[0]! ^ 1;
    expect(decryptItem(dek, "sealed", "item-a", badNonce, ciphertext)).toBeNull();

    expect(decryptItem(dek, "sealed", "item-b", nonce, ciphertext)).toBeNull();
    expect(decryptItem(dek, "secure", "item-a", nonce, ciphertext)).toBeNull();
    expect(decryptItem(newDek(), "sealed", "item-a", nonce, ciphertext)).toBeNull();
  });

  it("uses a fresh nonce on every write", () => {
    const dek = newDek();
    const a = encryptItem(dek, "secure", "x", { value: "same" });
    const b = encryptItem(dek, "secure", "x", { value: "same" });
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("accepts only bounded, power-of-two key parameters", () => {
    expect(parseKdfParams('{"N":131072,"r":8,"p":1}')).toEqual({ N: 131072, r: 8, p: 1 });
    expect(() => parseKdfParams('{"N":131073,"r":8,"p":1}')).toThrow();
    expect(() => parseKdfParams('{"N":2147483648,"r":8,"p":1}')).toThrow();
    expect(() => parseKdfParams('{"N":512,"r":8,"p":1}')).toThrow();
    expect(() => parseKdfParams('{"N":1024,"r":0,"p":1}')).toThrow();
  });
});
