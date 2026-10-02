import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumeAndroidNonce, mintAndroidNonce, revokeAllAndroidNonces,
} from "../../../src/services/android/android-nonce.ts";

describe("android session nonces", () => {
  beforeEach(() => revokeAllAndroidNonces());

  test("a nonce names the device it was minted for", () => {
    expect(consumeAndroidNonce(mintAndroidNonce("4242:8554"))).toBe("4242:8554");
  });

  // The entire reason the nonce exists: replaying a captured WS handshake must not work.
  test("is single use", () => {
    const nonce = mintAndroidNonce("4242:8554");
    expect(consumeAndroidNonce(nonce)).toBe("4242:8554");
    expect(consumeAndroidNonce(nonce)).toBeNull();
  });

  test("an unknown nonce is rejected", () => {
    expect(consumeAndroidNonce("not-a-nonce")).toBeNull();
  });

  test("two mints never collide", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintAndroidNonce("d")));
    expect(seen.size).toBe(200);
  });

  // A client that mints and never connects must not be able to grow the map without bound.
  test("outstanding nonces are capped", () => {
    const first = mintAndroidNonce("d");
    for (let i = 0; i < 64; i++) mintAndroidNonce("d");
    expect(consumeAndroidNonce(first)).toBeNull();
  });
});
