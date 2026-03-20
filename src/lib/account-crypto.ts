import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const ALGO = "aes-256-gcm";

let keyPath = resolve(homedir(), ".ppm", "account.key");

/** Override key path (for tests) */
export function setKeyPath(path: string): void {
  keyPath = path;
  _key = null; // invalidate cached key
}

function loadOrCreateKey(): Buffer {
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf-8").trim(), "hex");
  }
  const key = randomBytes(32);
  mkdirSync(resolve(keyPath, ".."), { recursive: true });
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (!_key) _key = loadOrCreateKey();
  return _key;
}

/** Encrypt plaintext → "iv:authTag:ciphertext" (hex) */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypt "iv:authTag:ciphertext" → plaintext */
export function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, ctHex] = parts;
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf-8");
}
