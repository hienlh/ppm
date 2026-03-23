import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Password-based encryption for portable export (cross-machine)
// ---------------------------------------------------------------------------

interface EncryptedExport {
  version: 1;
  kdf: "scrypt";
  salt: string;    // hex, 32 bytes
  iv: string;      // hex, 12 bytes
  authTag: string; // hex, 16 bytes
  ciphertext: string; // base64
}

/** Encrypt payload with user password → portable encrypted JSON blob */
export function encryptWithPassword(plaintext: string, password: string): string {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  // scrypt N=16384 (r=8, p=1) → 16MB mem, ~50ms — secure & within Node/Bun default limits
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const envelope: EncryptedExport = {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    ciphertext: enc.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/** Decrypt portable encrypted JSON blob with user password → plaintext */
export function decryptWithPassword(blob: string, password: string): string {
  let envelope: EncryptedExport;
  try { envelope = JSON.parse(blob); } catch { throw new Error("Invalid backup format"); }
  if (envelope.version !== 1 || envelope.kdf !== "scrypt") throw new Error("Unsupported backup version");
  const salt = Buffer.from(envelope.salt, "hex");
  const iv = Buffer.from(envelope.iv, "hex");
  const authTag = Buffer.from(envelope.authTag, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
  } catch {
    throw new Error("Wrong password or corrupted backup");
  }
}

/** Decrypt "iv:authTag:ciphertext" → plaintext */
export function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf-8");
}
