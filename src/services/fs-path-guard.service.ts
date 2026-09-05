import { resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { getPpmDir } from "./ppm-dir.ts";
import { realPathOrSelf, realPathOrSelfSync } from "./fs-ops/fs-real-path.ts";

// Re-exported so callers reach both the guards and the resolver they build on
// through one import.
export { realPathOrSelf, realPathOrSelfSync };

// The credential-path predicates (PPM dir + ~/.cloudflared) live in their own
// module so this file stays focused on the platform allowlist and protected
// roots; re-exported here so every existing caller keeps a single import.
export {
  isPpmDirPath,
  isChatUploadPath,
  isCloudflaredDirPath,
  isCredentialPath,
  assertNotPpmDir,
  assertNotPpmSubtree,
  assertNotPpmSubtreeDeep,
} from "./fs-credential-path-guard.ts";

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
