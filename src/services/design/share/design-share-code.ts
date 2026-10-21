import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "../../ppm-dir.ts";

/**
 * Share codes are derived, never stored: `code = base64url(HMAC-SHA256(secret, "<id>.<v>"))`
 * with a 32-byte secret in the PPM dir. The database keeps only `sha256(code)`, so the owner
 * can copy a link again at any time, while a leaked `ppm.db` or backup opens nothing.
 * Deleting the secret file retires every code at once (the links then need a new code).
 */

const SECRET_FILE = "design-share.key";
const SECRET_BYTES = 32;
/** 256 bits in unpadded base64url. */
export const SHARE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

interface CachedSecret { key: Buffer; ino: number; mtimeMs: number; size: number }
let cached: CachedSecret | null = null;

function secretPath(): string {
  return resolve(getPpmDir(), SECRET_FILE);
}

/** Block the thread briefly: the secret is read on synchronous paths. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function statOrNull(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

/** Claim the file with `wx`, so two first uses (two processes) cannot write different keys. */
function createSecret(path: string): boolean {
  mkdirSync(getPpmDir(), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, randomBytes(SECRET_BYTES));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Read the secret, waiting out a creator that has claimed the file but not written it yet.
 * A file that stays the wrong size was never a usable key, so no code depends on it and it
 * is replaced.
 */
function readSecret(path: string): Buffer {
  for (let attempt = 0; attempt < 50; attempt++) {
    const data = readFileSync(path);
    if (data.length === SECRET_BYTES) return data;
    pause(5);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, randomBytes(SECRET_BYTES));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return readFileSync(path);
}

/**
 * The share secret, created on first use. Re-read whenever the file changes, so deleting it
 * takes effect without a restart.
 */
export function loadSecret(): Buffer {
  const path = secretPath();
  let st = statOrNull(path);
  if (cached && st && st.ino === cached.ino && st.mtimeMs === cached.mtimeMs && st.size === cached.size) {
    return cached.key;
  }
  if (!st) {
    createSecret(path);
  }
  const key = readSecret(path);
  st = statSync(path);
  cached = { key, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
  return key;
}

/** Forget the cached secret (tests). */
export function resetShareSecretCache(): void {
  cached = null;
}

export function deriveCode(linkId: string, codeVersion: number): string {
  return createHmac("sha256", loadSecret()).update(`${linkId}.${codeVersion}`).digest("base64url");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Whether `code` is the one currently derived for this link (constant time). */
export function codeMatches(code: string, linkId: string, codeVersion: number): boolean {
  const expected = Buffer.from(deriveCode(linkId, codeVersion));
  const given = Buffer.from(code);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
