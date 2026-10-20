import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { getBackupsDir } from "../db-backup/db-backup-paths.ts";
import { realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";
import { isInside, isWindowsNonDrivePath } from "../design/design-tool-policy.ts";

/**
 * Folders and files the PPM Assistant never reads without asking, even inside a registered
 * project. The Assistant's rule is that reads inside projects run unasked; a project registered
 * at (or above) the home folder would otherwise hand it every credential store under it. So
 * besides PPM's own credential roots — the PPM dir (config database, Codex account homes), the
 * Cloudflare login and the database snapshots — this lists where common tools keep logins and
 * keys, and treats the home folder's application-state area as private while the only projects
 * holding it are the home folder or above (`isAssistantPrivatePath`). Only the Assistant
 * consults it; the generic file routes keep the narrower `fs-credential-path-guard.ts`, because
 * a person browsing their own files is not this case.
 *
 * Real `homedir()` on purpose, like `~/.cloudflared` in that guard: the tools that write these
 * stores decide where they live, not PPM.
 */

/**
 * Under the home folder, relative to it. A file is listed as a file, a store spread over a folder
 * as the folder. These ask even inside a project registered below the home folder (one at
 * `~/.config` still may not read `~/.config/gh` unasked).
 */
const HOME_CREDENTIAL_STORES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".config/gcloud",
  ".config/gh",
  ".claude.json",
  ".claude/.credentials.json",
  ".codex/auth.json",
];

/**
 * Whole trees whose files describe the running machine rather than anyone's project, and which
 * hand out secrets to a plain read.
 *  - Linux: `/proc/<pid>/environ` and `/proc/self/environ` carry a process's environment — the
 *    CLI's own holds the provider's API key or OAuth token — and `cmdline`/`fd/` reach further;
 *    `/sys` exposes firmware tables and device state; `/dev` holds raw disks, memory and input
 *    devices, and a read of some of them never ends.
 *  - macOS: no `/proc` or `/sys`, but `/dev` has the same raw disks and `/dev/fd/<n>`, which
 *    reopens the reading process's own descriptors (its stdin carries the conversation).
 *  - Windows: devices live in the `\\.\` namespace, which `isWindowsNonDrivePath` already
 *    refuses from the text alone, and there is no file-backed process table to add.
 */
function systemPrivateRoots(platform: string): string[] {
  if (platform === "linux") return ["/proc", "/sys", "/dev"];
  if (platform === "darwin") return ["/dev"];
  return [];
}

/** Stores whose place another variable can move; each listed wherever it currently points. */
function relocatedStores(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.CLAUDE_CONFIG_DIR) out.push(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
  if (env.CODEX_HOME) out.push(join(env.CODEX_HOME, "auth.json"));
  if (env.XDG_CONFIG_HOME) out.push(join(env.XDG_CONFIG_HOME, "gcloud"), join(env.XDG_CONFIG_HOME, "gh"), join(env.XDG_CONFIG_HOME, "git", "credentials"));
  if (env.GNUPGHOME) out.push(env.GNUPGHOME);
  // Windows keeps gcloud's and gh's logins under the roaming profile rather than `~/.config`.
  if (env.APPDATA) out.push(join(env.APPDATA, "gcloud"), join(env.APPDATA, "GitHub CLI"));
  return out;
}

/**
 * A path as configured and as the filesystem has it: a path is judged by its real location,
 * which never spells a root through a symlink (`/tmp` → `/private/tmp` on macOS, a home folder
 * that is itself a link). A path that names no drive on Windows is kept as written and never
 * resolved, since resolving it would reach out over the network.
 */
function spellings(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    out.add(path);
    if (!isWindowsNonDrivePath(path)) out.add(realPathOrSelfSync(path));
  }
  return [...out];
}

/**
 * Every fixed private root, each in both spellings. Read per call, not cached — a store created
 * after the first check (`~/.aws` on a later `aws configure`) may be a link, and a cached
 * spelling would miss where it points.
 */
export function assistantPrivateRoots(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string[] {
  return spellings([
    getPpmDir(),
    join(getPpmDir(), "codex-accounts"),
    resolve(home, ".cloudflared"),
    getBackupsDir(),
    ...HOME_CREDENTIAL_STORES.map((entry) => resolve(home, entry)),
    ...relocatedStores(env).map((p) => resolve(p)),
    ...systemPrivateRoots(platform),
  ]);
}

/** What a path is judged against: the fixed roots, the home folder and the registered projects. */
export interface AssistantPrivateScope {
  roots: readonly string[];
  /** The home folder, both spellings. */
  homes: readonly string[];
  /** Every registered project's root, both spellings. */
  projectRoots: readonly string[];
  platform: string;
}

export function assistantPrivateScope(opts: {
  projectRoots: readonly string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** Replaces the fixed roots, for tests. */
  roots?: readonly string[];
}): AssistantPrivateScope {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  return {
    roots: opts.roots ?? assistantPrivateRoots(home, opts.env ?? process.env, platform),
    homes: spellings([resolve(home)]),
    projectRoots: spellings(opts.projectRoots.map((p) => resolve(p))),
    platform,
  };
}

/**
 * Where applications keep their own state under a home folder: every dot-entry (`.config`,
 * `.local/share`, `.mozilla`, `.password-store`, `.zsh_history`, `.pgpass`, `.vault-token`…),
 * macOS's `Library` (browser profiles, keychains, app containers) and Windows' `AppData`, which
 * holds the same browser profiles and app logins there. Too many tools keep logins in these for
 * a list of known stores to cover; a project of the user's own is never kept in them unless
 * they registered it there.
 */
function isHomeStateEntry(name: string, platform: string): boolean {
  if (name.startsWith(".")) return true;
  const folded = platform === "win32" || platform === "darwin" ? name.toLowerCase() : name;
  const library = platform === "win32" || platform === "darwin" ? "library" : "Library";
  return folded === library || (platform === "win32" && folded === "appdata");
}

/** `path` relative to `root` when inside it, folded the way `isInside` folds; null otherwise. */
function relativeInside(path: string, root: string): string | null {
  if (!isInside(path, root)) return null;
  const fold = process.platform === "win32" || process.platform === "darwin";
  const rel = relative(fold ? root.toLowerCase() : root, fold ? path.toLowerCase() : path);
  return isAbsolute(rel) ? null : rel;
}

/**
 * Whether `path` lies in the home folder's application-state area while every registered
 * project holding it is the home folder or one of its ancestors. A project registered inside
 * the home folder (`~/.dotfiles`, `~/.config/nvim`) holds its own tree as any project does,
 * and a path no project holds is "outside every project", asked as that.
 */
function inHomeStateArea(path: string, scope: AssistantPrivateScope): boolean {
  for (const home of scope.homes) {
    const rel = relativeInside(path, home);
    if (!rel) continue;
    const first = rel.split(/[\\/]/)[0]!;
    if (!isHomeStateEntry(first, scope.platform)) continue;
    const holders = scope.projectRoots.filter((root) => isInside(path, root));
    if (holders.length === 0) return false;
    const holdsHome = (root: string) => scope.homes.some((h) => isInside(h, root));
    return holders.every(holdsHome);
  }
  return false;
}

/** Whether `path` (already resolved through symlinks) is private to the Assistant. */
export function isAssistantPrivatePath(path: string, scope: AssistantPrivateScope): boolean {
  return scope.roots.some((root) => isInside(path, root)) || inHomeStateArea(path, scope);
}

/**
 * A private root lying inside the folder `dir` — what a recursive search from `dir` would walk
 * into — or null. A folder holding the home folder holds its application-state area too.
 */
export function privateRootWithin(dir: string, scope: AssistantPrivateScope): string | null {
  return scope.roots.find((root) => isInside(root, dir)) ?? scope.homes.find((home) => isInside(home, dir)) ?? null;
}
