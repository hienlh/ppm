import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";
import { getDb, getDbPath } from "./db.service.ts";

/**
 * The only shape an avatar filename may have: what `writeAvatar` returns. The `image` column can
 * also be written by `ppm config set projects.N.image` or an extension, and the name is joined
 * under the avatars directory to serve and to delete it — so anything else (`../ppm.db`) is
 * refused rather than resolved.
 */
const AVATAR_FILENAME = /^[0-9a-f]{64}\.webp$/;

export function isAvatarFilename(name: unknown): name is string {
  return typeof name === "string" && AVATAR_FILENAME.test(name);
}

/**
 * Directory holding custom project avatars. Does NOT create it.
 *
 * One per database file: `ppm.db` and `ppm.dev.db` live in the same PPM directory, and the
 * "is this file still used?" check can only ask the database it runs on. With one shared folder,
 * a dev server dropping its last reference deleted a picture the production database still named.
 */
export function getAvatarsDir(): string {
  const profile = dbProfileName();
  return join(getPpmDir(), profile ? `avatars.${profile}` : "avatars");
}

/** "" for `ppm.db`, `dev` for `ppm.dev.db`. */
function dbProfileName(): string {
  const db = basename(getDbPath()).replace(/\.db$/, "");
  return db === "ppm" ? "" : db.replace(/^ppm\./, "");
}

/**
 * Where to read an avatar from. A profile database (`ppm.dev.db`) used to share `avatars/` with
 * `ppm.db`, so its rows can still name a file that only exists there: such a file is read from
 * the shared folder, and never deleted from it — the production database may name it too, and
 * this process can only ask its own database. Null when the file is in neither.
 */
export function avatarReadPath(filename: string): string | null {
  const own = avatarPath(filename);
  if (existsSync(own)) return own;
  if (!dbProfileName()) return null;
  const shared = join(getPpmDir(), "avatars", filename);
  return existsSync(shared) ? shared : null;
}

/** Ensure the avatars dir exists, return its path. */
export function ensureAvatarsDir(): string {
  const dir = getAvatarsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path for an avatar filename; throws for anything `writeAvatar` could not have named. */
export function avatarPath(filename: string): string {
  if (!isAvatarFilename(filename)) throw new Error("Invalid avatar filename");
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
 * reference has been saved, or the row being changed still counts. A name that is not an avatar
 * filename is ignored, never resolved. Only this database's own folder is touched (see
 * `avatarReadPath`). Swallows ENOENT / missing filename.
 */
export function deleteAvatar(filename?: string): void {
  if (!isAvatarFilename(filename)) return;
  if (avatarStillReferenced(filename)) return;
  const dest = avatarPath(filename);
  try {
    if (existsSync(dest)) unlinkSync(dest);
  } catch {
    /* ignore — best-effort cleanup */
  }
}
