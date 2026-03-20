import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

// Override key path before importing crypto module
const testKeyPath = resolve(tmpdir(), `ppm-test-account-${Date.now()}.key`);

// Dynamic import after setting up key path override
let encrypt: (s: string) => string;
let decrypt: (s: string) => string;
let setKeyPath: (p: string) => void;

beforeAll(async () => {
  const mod = await import("../../../src/lib/account-crypto.ts");
  setKeyPath = mod.setKeyPath;
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
  setKeyPath(testKeyPath);
});

afterAll(() => {
  if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
});

describe("account-crypto", () => {
  it("encrypt then decrypt returns original", () => {
    const original = "test-access-token-abc123";
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.split(":")).toHaveLength(3); // iv:tag:ciphertext
    expect(decrypt(encrypted)).toBe(original);
  });

  it("same input produces different ciphertext each time (random IV)", () => {
    const plain = "same-token-value";
    const enc1 = encrypt(plain);
    const enc2 = encrypt(plain);
    expect(enc1).not.toBe(enc2);
    // Both should still decrypt correctly
    expect(decrypt(enc1)).toBe(plain);
    expect(decrypt(enc2)).toBe(plain);
  });

  it("decrypt with wrong format throws", () => {
    expect(() => decrypt("not-valid-format")).toThrow();
  });

  it("handles empty string", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  it("handles long token strings", () => {
    const long = "a".repeat(1000);
    expect(decrypt(encrypt(long))).toBe(long);
  });
});
