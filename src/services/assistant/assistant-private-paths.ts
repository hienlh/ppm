import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
 * keys. Only the Assistant consults it; the generic file routes keep the narrower
 * `fs-credential-path-guard.ts`, because a person browsing their own files is not this case.
 *
 * Real `homedir()` on purpose, like `~/.cloudflared` in that guard: the tools that write these
 * stores decide where they live, not PPM.
 */

/** Under the home folder, relative to it. A file is listed as a file, a store spread over a folder as the folder. */
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
 * Every private root, each as configured and as the filesystem has it: a path is judged by its
 * real location, which never spells a root through a symlink (`/tmp` → `/private/tmp` on macOS,
 * a home folder that is itself a link). Read per call, not cached — a store created after the
 * first check (`~/.aws` on a later `aws configure`) may be a link, and a cached spelling would
 * miss where it points. A root that names no drive on Windows is kept as written and never
 * resolved, since resolving it would reach out over the network.
 */
export function assistantPrivateRoots(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [
    getPpmDir(),
    join(getPpmDir(), "codex-accounts"),
    resolve(home, ".cloudflared"),
    getBackupsDir(),
    ...HOME_CREDENTIAL_STORES.map((entry) => resolve(home, entry)),
    ...relocatedStores(env).map((p) => resolve(p)),
  ];
  const spellings = new Set<string>();
  for (const root of configured) {
    spellings.add(root);
    if (!isWindowsNonDrivePath(root)) spellings.add(realPathOrSelfSync(root));
  }
  return [...spellings];
}

/** Whether `path` (already resolved through symlinks) is a private root or inside one. */
export function isAssistantPrivatePath(path: string, roots: readonly string[] = assistantPrivateRoots()): boolean {
  return roots.some((root) => isInside(path, root));
}

/** A private root lying inside the folder `dir` — what a recursive search from `dir` would walk into — or null. */
export function privateRootWithin(dir: string, roots: readonly string[] = assistantPrivateRoots()): string | null {
  return roots.find((root) => isInside(root, dir)) ?? null;
}
