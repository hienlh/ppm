import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";
import { getDb } from "./db.service.ts";

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

/**
 * Whether any project row still names this avatar. Asked of the database rather than the list in
 * memory: files are content-addressed, so two projects given the same picture share one file, and
 * the other project may have been set by another process this one has not reloaded from. Answers
 * true when the database cannot be asked — keeping an orphan file is harmless, deleting a used
 * one breaks a project's avatar.
 */
function avatarStillReferenced(filename: string): boolean {
  try {
    return getDb().query("SELECT 1 FROM projects WHERE image = ? LIMIT 1").get(filename) !== null;
  } catch {
    return true;
  }
}

/**
 * Delete an avatar file once no project references it. Call it after the change that dropped the
 * reference has been saved, or the row being changed still counts. Swallows ENOENT / missing filename.
 */
export function deleteAvatar(filename?: string): void {
  if (!filename) return;
  if (avatarStillReferenced(filename)) return;
  const dest = avatarPath(filename);
  try {
    if (existsSync(dest)) unlinkSync(dest);
  } catch {
    /* ignore — best-effort cleanup */
  }
}
