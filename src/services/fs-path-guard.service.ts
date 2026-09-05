import { resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { getPpmDir } from "./ppm-dir.ts";
import { getUploadsDir } from "./chat-upload-storage.service.ts";
import { realPathOrSelf, realPathOrSelfSync } from "./fs-ops/fs-real-path.ts";

// Re-exported so callers reach both the guards and the resolver they build on
// through one import.
export { realPathOrSelf, realPathOrSelfSync };

/**
 * Central guard for every filesystem route that works outside project scope.
 * The whole disk is browsable behind PPM auth, so the remaining defences are:
 * a normalized resolve, a platform allowlist that still rejects UNC shares,
 * a refusal for the PPM directory (holds the credentials DB) and a protected
 * root list so a stray rename cannot take out `$HOME` or a drive root.
 */

/** Structured mapping of an FS failure to an HTTP answer. */
export interface FsErrorInfo {
  status: number;
  code: string;
  message: string;
  hint?: string;
}

/**
 * Resolve a path, expanding a leading `~` to the home directory. Only a bare
 * `~` or `~/`…`~\` expands: `~foo` is a user-home shorthand this code does not
 * implement, and slicing it blindly would silently resolve to `$HOME/oo`.
 */
export function resolvePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return resolve(homedir(), input.slice(2));
  }
  return resolve(input);
}

/** Case-insensitive prefix test on Windows/macOS-style paths. */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Whitelist for system-level access. POSIX exposes the whole tree; Windows
 * requires a drive letter, which keeps UNC shares (`\\server\share`) out —
 * they are unsupported in this version because they can block indefinitely.
 */
export function isAllowedPath(resolved: string): boolean {
  // The platform shape is decided first: a UNC path must stay rejected even
  // when it also matches the exception below, or an attacker-named share
  // (\\host\claude\x\tasks\y.output) would turn a read into an outbound SMB
  // fetch to their server.
  const shapeAllowed =
    process.platform === "win32" ? /^[A-Za-z]:\\/.test(resolved) : resolved.startsWith("/");
  if (shapeAllowed) return true;

  // SDK background-command output lives under the OS temp dir; the chat output
  // panel reads those files directly. Matched by structure so it survives the
  // per-platform claude dir naming ("claude" vs "claude-<uid>"), but never for
  // a UNC path.
  if (isUncPath(resolved)) return false;
  return /[\\/]claude[^\\/]*[\\/].+[\\/]tasks[\\/][^\\/]+\.output$/.test(resolved);
}

/** `\\server\share\…` (or the forward-slash spelling). */
function isUncPath(candidate: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(candidate);
}

/** Throw a 403 when a path is outside the allowlist. */
export function assertAllowed(resolved: string): void {
  if (!isAllowedPath(resolved)) {
    throw Object.assign(new Error("Access denied"), { status: 403, code: "EDENIED" });
  }
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
 * must never be servable through a generic file route, same as the PPM
 * config DB. `isInside` is a prefix match against this exact resolved path,
 * not a substring test, so an unrelated folder that merely contains
 * ".cloudflared" as a path segment elsewhere does not match.
 */
export function isCloudflaredDirPath(resolved: string): boolean {
  return isInside(resolved, resolve(homedir(), ".cloudflared"));
}

/** True when the path holds credential material a generic file route must never serve. */
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
 * Refuse operations that would take the PPM directory's contents anywhere
 * else. Reading that subtree is already blocked, so without this a copy to a
 * public path followed by an ordinary read would still hand out the
 * credentials database.
 */
export function assertNotPpmSubtree(candidate: string): void {
  if (isPpmDirPath(candidate)) {
    throw Object.assign(new Error(`Refusing to operate on the PPM directory: ${candidate}`), {
      status: 403,
      code: "EPROTECTED",
    });
  }
}

/**
 * Same refusal, applied to the real path as well. A path that does not exist
 * yet is still resolved through its parents, so a symlinked directory cannot
 * be used to reach — or create something inside — the PPM directory.
 */
export async function assertNotPpmSubtreeDeep(candidate: string): Promise<void> {
  assertNotPpmSubtree(candidate);
  assertNotPpmSubtree(await realPathOrSelf(candidate));
}

/** Paths whose removal or rename would break the host or PPM itself. */
export function isProtectedRoot(candidate: string): boolean {
  const p = resolve(candidate);
  if (p === "/" ) return true;
  if (/^[A-Za-z]:\\?$/.test(p)) return true;
  const norm = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v);
  return norm(p) === norm(homedir()) || norm(p) === norm(getPpmDir());
}

/**
 * Reject destructive operations on protected roots. For a real entry the
 * realpath is checked too, so a symlinked *directory* cannot be used as a
 * proxy for `$HOME`. A symlink is exempt from that second check: every
 * operation here acts on the link itself, and deleting a shortcut that points
 * at the home directory removes the shortcut, not the home directory.
 */
export async function assertNotProtected(candidate: string): Promise<void> {
  const deny = () => {
    throw Object.assign(new Error(`Refusing to modify a protected path: ${candidate}`), {
      status: 403,
      code: "EPROTECTED",
    });
  };
  if (isProtectedRoot(candidate)) deny();
  try {
    if ((await lstat(candidate)).isSymbolicLink()) return;
    if (isProtectedRoot(await realpath(candidate))) deny();
  } catch (e) {
    if ((e as { status?: number }).status === 403) throw e;
    // Unresolvable path (missing or broken link) — the plain check already ran.
  }
}

const HINT_EPERM =
  process.platform === "darwin"
    ? "grant Full Disk Access to the process running ppm"
    : "the process running ppm lacks permission for this path";

/** Map a Node FS error (or a guard error carrying `status`) to an HTTP answer. */
export function mapFsError(e: unknown): FsErrorInfo {
  const err = e as { status?: number; code?: string; message?: string };
  const message = err?.message || "Filesystem error";
  if (typeof err?.status === "number") {
    // A refusal we decided ourselves is not a permission problem the user can
    // fix, so the OS-permission hint only rides along on real EPERM/EACCES.
    const osDenied = err.code === "EPERM" || err.code === "EACCES";
    return {
      status: err.status,
      code: err.code || "EFAIL",
      message,
      hint: osDenied ? HINT_EPERM : undefined,
    };
  }
  switch (err?.code) {
    case "ENOENT":
      return { status: 404, code: "ENOENT", message };
    case "EEXIST":
    case "ERR_FS_CP_EEXIST":
      return { status: 409, code: "EEXIST", message };
    case "ENOTEMPTY":
      return { status: 409, code: "ENOTEMPTY", message };
    case "EPERM":
    case "EACCES":
      return { status: 403, code: err.code, message, hint: HINT_EPERM };
    case "ENOTDIR":
    case "EISDIR":
    case "EINVAL":
      return { status: 400, code: err.code, message };
    case "EBUSY":
      return { status: 409, code: "EBUSY", message };
    default:
      return { status: 500, code: err?.code || "EFAIL", message };
  }
}
