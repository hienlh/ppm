import { join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { getPpmDir } from "./ppm-dir.ts";
import { getUploadsDir } from "./chat-upload-storage.service.ts";
import { getBackupsDir } from "./db-backup/db-backup-paths.ts";
import { realPathOrSelf, realPathOrSelfSync } from "./fs-ops/fs-real-path.ts";

/**
 * Every path a generic filesystem route (read, write, copy, move, upload,
 * trash…) must refuse because it holds credential material: the PPM config
 * DB (provider keys, auth token) and `~/.cloudflared` (the Cloudflare login
 * cert). Split out of `fs-path-guard.service.ts` so this one seam — "is this
 * a credential path" — stays a single file instead of growing alongside the
 * platform-allowlist and protected-root logic that lives there.
 *
 * Three roots, not two: the PPM config DB, `~/.cloudflared`, and the database
 * snapshot directory, which holds full copies of the first one.
 */

/** Case-insensitive prefix test on Windows/macOS-style paths. */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Each root's real path, keyed by the root as configured. */
const realRoots = new Map<string, string>();

/**
 * The spellings a root is reached by: as configured, and as the filesystem has it.
 * Every door checks a path *and* its real path, and a real path never spells a
 * root through a symlink — on macOS `/tmp` and `/var` are links into `/private`,
 * so a PPM directory under either matched only the first check, and a symlink
 * to `ppm.db` read as an ordinary file. Resolved once per root, because the
 * design walk asks per entry: the real spelling only adds refusals, so one that
 * goes stale refuses no less than the configured spelling alone did.
 */
function rootSpellings(root: string): string[] {
  let real = realRoots.get(root);
  if (real === undefined) {
    real = realPathOrSelfSync(root);
    realRoots.set(root, real);
  }
  return real === root ? [root] : [root, real];
}

const isUnderRoot = (child: string, root: string) => rootSpellings(root).some((spelling) => isInside(child, spelling));

/**
 * A directory inside the PPM directory, spelled under each of the PPM directory's
 * own spellings and never at its own real path. The two exceptions below are holes
 * in the PPM-dir refusal: were `uploads` itself a link, its real path would carry
 * the hole to wherever the link points — the snapshot directory, or the PPM
 * directory itself.
 */
function ppmSubdirSpellings(dir: string): string[] {
  const rel = relative(getPpmDir(), dir);
  return rootSpellings(getPpmDir()).map((spelling) => join(spelling, rel));
}

/** True when the path is the PPM directory or anything inside it. */
export function isPpmDirPath(resolved: string): boolean {
  return isUnderRoot(resolved, getPpmDir());
}

/**
 * Chat attachments the user uploaded through the UI. They sit under the PPM
 * dir so chat history keeps resolving them across reboots, but they are
 * ordinary user content, not credential material: the transcript has to render
 * the very image the assistant just read back from that directory.
 */
export function isChatUploadPath(resolved: string): boolean {
  return ppmSubdirSpellings(getUploadsDir()).some((spelling) => isInside(resolved, spelling));
}

/**
 * Images the codex image-generation tool produced. Codex writes them under its
 * own CODEX_HOME, which PPM places inside the PPM dir, so `isPpmDirPath` covers
 * them and the chat could not render a picture the assistant had just made.
 * There are two kinds of such home: one per account (`codex-accounts/<id>`),
 * and the PPM Assistant's own per account (`assistant/codex-homes/<key>`,
 * `assistantCodexHomesRoot()` in `codex-assistant-home.ts`), whose app-server
 * writes its pictures into that home's `generated_images`.
 *
 * The match is structural rather than a lookup of the account table: the path
 * must be `<one of those roots>/<something>/generated_images/<at least one
 * more segment>`. That keeps the exception to the one subtree codex fills with
 * generated pictures and leaves the rest of a home — `auth.json` above all,
 * but equally the session, log, and memory databases beside it, and the
 * Assistant home's link to the account's sessions — refused, since none of
 * those sit under a `generated_images` segment. Callers pass an
 * already-resolved path, so `..` cannot walk back out of the subtree, and they
 * check the real path as well, so a `generated_images` replaced by a link into
 * the rest of the PPM dir is refused there.
 */
export function isCodexGeneratedImagePath(resolved: string): boolean {
  const homes = [resolve(getPpmDir(), "codex-accounts"), resolve(getPpmDir(), "assistant", "codex-homes")];
  return homes.flatMap(ppmSubdirSpellings).some((root) => {
    if (!isInside(resolved, root) || resolved === root) return false;
    const rel = resolved.slice(root.length + 1).split(sep);
    // [home, "generated_images", …at least one file segment]
    return rel.length >= 3 && rel[1] === "generated_images";
  });
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
  return isUnderRoot(resolved, resolve(homedir(), ".cloudflared"));
}

/**
 * True when the path is the database-snapshot directory or anything inside it.
 *
 * A snapshot is a byte-for-byte copy of the config database, so it carries the
 * same provider keys, encrypted accounts, and auth token. In production that
 * directory deliberately sits OUTSIDE `~/.ppm` (so it survives a wipe of the
 * PPM directory), which means `isPpmDirPath` does not cover it — without this
 * branch, moving snapshots out of the PPM directory would have quietly opened
 * a credential-read hole through the generic file routes.
 */
export function isDbBackupsDirPath(resolved: string): boolean {
  return isUnderRoot(resolved, getBackupsDir());
}

/** True when the path holds credential material a generic file route must never serve or relocate. */
export function isCredentialPath(resolved: string): boolean {
  return isPpmDirPath(resolved) || isCloudflaredDirPath(resolved) || isDbBackupsDirPath(resolved);
}

/**
 * Refuse the PPM directory subtree and `~/.cloudflared` on read-style doors.
 * The former stores the config database with provider credentials and auth
 * tokens; the latter stores the Cloudflare login cert. Neither may be
 * downloadable through a generic file route.
 *
 * Chat uploads and codex-generated images are the exceptions, and they lift only
 * the PPM-dir refusal: `~/.cloudflared` and the snapshot directory are refused
 * whatever path reaches them. Every caller applies this to the requested path
 * *and* to its real path, so a symlink parked in the uploads directory still
 * fails on the second call and cannot reach the rest of the PPM dir through the
 * exception, and a symlink pointing at `~/.cloudflared/cert.pem` fails the same
 * way — as does a link put in place of the uploads directory itself, since the
 * exceptions are spelled from the PPM directory's own spellings.
 *
 * Both exceptions are read-only on purpose: they are absent from
 * `assertNotPpmSubtree`, so nothing can be copied, moved, or written INTO
 * those directories through a generic file route.
 */
export function assertNotPpmDir(resolved: string): void {
  const excepted = isChatUploadPath(resolved) || isCodexGeneratedImagePath(resolved);
  if (isCloudflaredDirPath(resolved) || isDbBackupsDirPath(resolved) || (isPpmDirPath(resolved) && !excepted)) {
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
