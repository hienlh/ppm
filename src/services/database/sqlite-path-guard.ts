import { homedir } from "node:os";
import { resolve } from "node:path";
import { isCloudflaredDirPath, isDbBackupsDirPath, isPpmDirPath } from "../fs-credential-path-guard.ts";
import { realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";
import { assistantPrivateScope, isAssistantPrivatePath } from "../assistant/assistant-private-paths.ts";
import { isWindowsNonDrivePath } from "../design/design-tool-policy.ts";
import { protectedFileLinkedAs } from "./sqlite-file-identity.ts";

/**
 * Which files a SQLite connection may open. A connection is opened with no further question —
 * the AI chat's `db_query` reads one unasked — so one pointed at a credential store would hand it
 * out: a copy of `ppm.db` in the snapshot folder, a symlink to it parked in a cloned repository,
 * the Cloudflare login. The file is judged by where it really is (its real path, or its parent's
 * for a file not created yet) as well as how it is spelled, at save time and again at every open,
 * for every caller, so a link swapped in after saving is refused too. A hard link has a real path
 * of its own, so it is also compared by file identity (`sqlite-file-identity.ts`), and Windows
 * spellings that name no drive (`\\?\`, `\\.\`, a share) are refused before any of this.
 *
 * The Assistant's own tools are held to more: nothing it keeps private either (`~/.ssh`, a
 * browser profile with `cookies.sqlite`, anything in the home folder's application-state area
 * that no registered project holds).
 */

export class SqlitePathRefusedError extends Error {
  readonly status = 403;
  readonly code = "EPROTECTED";
  constructor(message: string) {
    super(message);
    this.name = "SqlitePathRefusedError";
  }
}

export interface SqlitePathOptions {
  /**
   * The Assistant saving or testing a connection: also refuse what it keeps private. Every
   * registered project's folder, because a store inside one the user registered is theirs to open.
   */
  aiTool?: { projectRoots: readonly string[]; home?: string; roots?: readonly string[] };
  home?: string;
  /** Test seam: the platform whose path rules apply (defaults to this one). */
  platform?: string;
}

/** `file` as the PPM host would open it: `~` expanded, made absolute. */
export function sqliteFullPath(file: string, home: string = homedir()): string {
  const trimmed = file.trim();
  if (trimmed === "~" || /^~[\\/]/.test(trimmed)) return resolve(home, trimmed.slice(2));
  return resolve(trimmed);
}

/**
 * Where `file` really is. A Windows path naming no drive (a network share) is kept as written:
 * resolving it would reach out over the network, and a dead share would hold the caller.
 */
export function sqliteRealPath(file: string, home?: string): string {
  const full = sqliteFullPath(file, home);
  return isWindowsNonDrivePath(full) ? full : realPathOrSelfSync(full);
}

function credentialPlace(path: string): string | null {
  if (isPpmDirPath(path)) return "PPM's own data folder";
  if (isDbBackupsDirPath(path)) return "PPM's database snapshots";
  if (isCloudflaredDirPath(path)) return "the Cloudflare login folder";
  return null;
}

/** Why `file` may not be opened as a SQLite database, or null when it may. */
export function sqlitePathRefusal(file: string, opts: SqlitePathOptions = {}): string | null {
  const full = sqliteFullPath(file, opts.home);
  // `\\?\C:\…`, `\\.\…` and `\\host\share\…` name a file no drive path check recognises: the
  // same `ppm.db` spelled that way is not "inside" PPM's folder. A database on a share is not
  // something SQLite supports safely anyway, so these spellings are refused outright.
  if (isWindowsNonDrivePath(full, opts.platform)) {
    return `${full} is not a path on a local drive. PPM opens a SQLite file only by its drive path (like C:\\data\\app.db).`;
  }
  const real = sqliteRealPath(file, opts.home);
  const shown = real === full ? full : `${full} (really ${real})`;
  const place = credentialPlace(full) ?? credentialPlace(real);
  if (place) return `${shown} is in a protected location: ${place}. PPM does not open it as a database.`;
  const linked = protectedFileLinkedAs(real);
  if (linked) return `${shown} is another name (a hard link) for ${linked.path}, in a protected location: ${linked.place}. PPM does not open it as a database.`;
  if (opts.aiTool) {
    const home = opts.aiTool.home ?? opts.home ?? homedir();
    // The home folder counts as registered, so its application-state area is private unless a
    // project registered inside it holds the file.
    const scope = assistantPrivateScope({
      projectRoots: [home, ...opts.aiTool.projectRoots], home, ...(opts.aiTool.roots ? { roots: opts.aiTool.roots } : {}),
    });
    if (isAssistantPrivatePath(full, scope) || isAssistantPrivatePath(real, scope)) {
      return `${shown} is in a protected location, where logins and keys are kept. The Assistant does not open it; the user can add it themselves in PPM.`;
    }
  }
  return null;
}

/** Throws `SqlitePathRefusedError` for a file that may not be opened; answers its real path otherwise. */
export function assertSqlitePathAllowed(file: string, opts: SqlitePathOptions = {}): string {
  const refusal = sqlitePathRefusal(file, opts);
  if (refusal) throw new SqlitePathRefusedError(refusal);
  return sqliteRealPath(file, opts.home);
}
