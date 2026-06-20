import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";

/** Directory holding custom project avatars. Does NOT create it. */
export function getAvatarsDir(): string {
  return join(getPpmDir(), "avatars");
}

/** Ensure the avatars dir exists, return its path. */
export function ensureAvatarsDir(): string {
  const dir = getAvatarsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path for an avatar filename (no traversal validation — caller guards). */
export function avatarPath(filename: string): string {
  return join(getAvatarsDir(), filename);
}

/**
 * Write avatar bytes content-addressed by sha256. Returns the `<hash>.webp`
 * filename. Skips the write if an identical file already exists (dedup).
 */
export function writeAvatar(bytes: Uint8Array): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filename = `${hash}.webp`;
  ensureAvatarsDir();
  const dest = avatarPath(filename);
  if (!existsSync(dest)) writeFileSync(dest, bytes);
  return filename;
}

/** Delete an avatar file if present. Swallows ENOENT / missing filename. */
export function deleteAvatar(filename?: string): void {
  if (!filename) return;
  const dest = avatarPath(filename);
  try {
    if (existsSync(dest)) unlinkSync(dest);
  } catch {
    /* ignore — best-effort cleanup */
  }
}
