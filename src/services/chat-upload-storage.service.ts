import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getPpmDir } from "./ppm-dir.ts";

/**
 * Storage for chat attachments (images and other uploaded files).
 *
 * Lives under the PPM dir, not the OS temp dir: chat history references these
 * files indefinitely, and the OS is free to delete anything in temp on cleanup or
 * reboot — which silently broke images in old conversations.
 *
 * Mirrors avatar-storage.service.ts. Never call homedir() directly here — the
 * PPM dir is resolved via getPpmDir() so tests can isolate it with PPM_HOME.
 */
export function getUploadsDir(): string {
  return join(getPpmDir(), "uploads");
}

/** Ensure the uploads dir exists, return its path. */
export function ensureUploadsDir(): string {
  const dir = getUploadsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where uploads used to be written. Still read from so images in existing chat
 * history keep resolving; nothing new is ever written here.
 */
function legacyUploadsDir(): string {
  return resolve(tmpdir(), "ppm-uploads");
}

/**
 * Absolute path for an upload filename, preferring the durable location and
 * falling back to the legacy temp dir. Returns null when the file exists in
 * neither. Caller must validate `filename` against path traversal first.
 */
export function resolveUploadPath(filename: string): string | null {
  const current = join(getUploadsDir(), filename);
  if (existsSync(current)) return current;
  const legacy = join(legacyUploadsDir(), filename);
  if (existsSync(legacy)) return legacy;
  return null;
}
