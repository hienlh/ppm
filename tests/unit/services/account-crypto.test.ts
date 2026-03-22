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
let encryptWithPassword: (s: string, pw: string) => string;
let decryptWithPassword: (s: string, pw: string) => string;

beforeAll(async () => {
  const mod = await import("../../../src/lib/account-crypto.ts");
  setKeyPath = mod.setKeyPath;
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
  encryptWithPassword = mod.encryptWithPassword;
  decryptWithPassword = mod.decryptWithPassword;
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

describe("account-crypto (password-based)", () => {
  it("encryptWithPassword / decryptWithPassword round-trips", () => {
    const payload = JSON.stringify([{ id: "abc", access_token: "sk-ant-oat-xxx" }]);
    const blob = encryptWithPassword(payload, "my-password");
    const parsed = JSON.parse(blob);
    expect(parsed.version).toBe(1);
    expect(parsed.kdf).toBe("scrypt");
    expect(parsed.ciphertext).not.toContain("sk-ant-oat-xxx");
    expect(decryptWithPassword(blob, "my-password")).toBe(payload);
  });

  it("wrong password throws 'Wrong password'", () => {
    const blob = encryptWithPassword("secret", "correct");
    expect(() => decryptWithPassword(blob, "wrong")).toThrow("Wrong password");
  });

  it("different calls produce different ciphertexts (random salt+iv)", () => {
    const blob1 = encryptWithPassword("same", "pass");
    const blob2 = encryptWithPassword("same", "pass");
    expect(JSON.parse(blob1).salt).not.toBe(JSON.parse(blob2).salt);
  });

  it("invalid format throws", () => {
    expect(() => decryptWithPassword("not-json", "pass")).toThrow();
    expect(() => decryptWithPassword(JSON.stringify({ version: 2, kdf: "scrypt" }), "pass")).toThrow("Unsupported backup version");
  });
});
