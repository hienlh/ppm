import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { getPpmDir } from "./ppm-dir.ts";
import { getUploadsDir } from "./chat-upload-storage.service.ts";
import { realPathOrSelf } from "./fs-ops/fs-real-path.ts";

/**
 * Every path a generic filesystem route (read, write, copy, move, upload,
 * trash…) must refuse because it holds credential material: the PPM config
 * DB (provider keys, auth token) and `~/.cloudflared` (the Cloudflare login
 * cert). Split out of `fs-path-guard.service.ts` so this one seam — "is this
 * a credential path" — stays a single file instead of growing alongside the
 * platform-allowlist and protected-root logic that lives there.
 */

/** Case-insensitive prefix test on Windows/macOS-style paths. */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** True when the path is the PPM directory or anything inside it. */
export function isPpmDirPath(resolved: string): boolean {
  return isInside(resolved, getPpmDir());
}

/**
 * Chat attachments the user uploaded through the UI. They sit under the PPM
 * dir so chat history keeps resolving them across reboots, but they are
 * ordinary user content, not credential material: the transcript has to render
 * the very image the assistant just read back from that directory.
 */
export function isChatUploadPath(resolved: string): boolean {
  return isInside(resolved, getUploadsDir());
}

/**
 * True when the path is `~/.cloudflared` or anything inside it. Real
 * `homedir()` is a deliberate exception to the getPpmDir()-only rule (see
 * CLAUDE.md "PPM Directory"): `cloudflared`, not PPM, decides this location,
 * and it holds `cert.pem` — an account-level Cloudflare login credential that
 * must never be servable through a generic file route. `isInside` is a
 * prefix match against this exact resolved path, not a substring test, so an
 * unrelated folder that merely contains ".cloudflared" as a path segment
 * elsewhere does not match.
 */
export function isCloudflaredDirPath(resolved: string): boolean {
  return isInside(resolved, resolve(homedir(), ".cloudflared"));
}

/** True when the path holds credential material a generic file route must never serve or relocate. */
export function isCredentialPath(resolved: string): boolean {
  return isPpmDirPath(resolved) || isCloudflaredDirPath(resolved);
}

/**
 * Refuse the PPM directory subtree and `~/.cloudflared` on read-style doors.
 * The former stores the config database with provider credentials and auth
 * tokens; the latter stores the Cloudflare login cert. Neither may be
 * downloadable through a generic file route.
 *
 * Chat uploads are the one exception, and only for the PPM-dir branch — chat
 * uploads always live under `getPpmDir()`, never under `~/.cloudflared`, so
 * the exception is a no-op for the cloudflared branch. Every caller applies
 * this to the requested path *and* to its real path, so a symlink parked in
 * the uploads directory still fails on the second call and cannot reach the
 * rest of the PPM dir through the exception, and a symlink pointing at
 * `~/.cloudflared/cert.pem` fails the same way.
 */
export function assertNotPpmDir(resolved: string): void {
  if (isCredentialPath(resolved) && !isChatUploadPath(resolved)) {
    throw Object.assign(new Error("Access denied"), { status: 403, code: "EDENIED" });
  }
}

/**
 * Refuse operations that would relocate a credential directory's contents
 * anywhere else — copy, move, rename, upload-over, trash. Reading a
 * credential path is already blocked by `assertNotPpmDir`, so without this a
 * copy to a public path followed by an ordinary read would still hand out
 * the PPM config DB or the Cloudflare login cert; every write/transfer door
 * in `fs-ops/` calls this on both the source and the destination.
 */
export function assertNotPpmSubtree(candidate: string): void {
  if (isCredentialPath(candidate)) {
    throw Object.assign(new Error(`Refusing to operate on a credential directory: ${candidate}`), {
      status: 403,
      code: "EPROTECTED",
    });
  }
}

/**
 * Same refusal, applied to the real path as well. A path that does not exist
 * yet is still resolved through its parents, so a symlinked directory cannot
 * be used to reach — or create something inside — a credential directory.
 */
export async function assertNotPpmSubtreeDeep(candidate: string): Promise<void> {
  assertNotPpmSubtree(candidate);
  assertNotPpmSubtree(await realPathOrSelf(candidate));
}
