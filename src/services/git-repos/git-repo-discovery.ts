/**
 * Which git repositories live under a project root.
 *
 * A workspace folder is not always a repository. The common shape is a
 * container — `~/work`, a monorepo of unrelated services, a folder of
 * checkouts — whose *children* are the repositories. Pointed at one of those,
 * every git surface ran `git` in a directory git knows nothing about and
 * reported "not a git repository", which reads as PPM being broken rather than
 * as the workspace being one level up.
 *
 * The behaviour follows VS Code's git extension, which scans each workspace
 * folder's subfolders (`git.autoRepositoryDetection`) to a bounded depth
 * (`git.repositoryScanMaxDepth`) with an ignore list
 * (`git.repositoryScanIgnoredFolders`). The differences here are deliberate:
 *
 * - **A `.git` *file* counts.** A linked worktree and a submodule both carry a
 *   file rather than a directory (`gitdir: …`), and both are repositories you
 *   can ask for a history. Testing `isDirectory()` would skip exactly the
 *   layouts most likely to be nested inside a container folder.
 * - **A found repository is not descended into.** Its own submodules are
 *   reachable from it, and listing them beside their superproject would offer
 *   the same history twice under two names.
 * - **The root short-circuits.** If the workspace folder is itself a
 *   repository, nothing below it is offered: that is the single-repo case and
 *   it must not grow a picker.
 */
import { readdirSync, lstatSync, existsSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

export interface GitRepoCandidate {
  /** Absolute path of the repository's working tree. */
  path: string;
  /** Directory name — what a picker shows first. */
  name: string;
  /** Path relative to the project root, `.` for the root itself. */
  relative: string;
}

export interface GitRepoDiscovery {
  /** The project root itself, resolved. */
  root: string;
  /** True when the root is a repository, in which case `repos` is just it. */
  rootIsRepo: boolean;
  repos: GitRepoCandidate[];
}

/**
 * Never descended into. Cheap to get wrong in the other direction: a missed
 * ignore costs a directory walk, a wrong ignore hides somebody's repository.
 * So this lists only directories that cannot themselves be a checkout you
 * opened PPM to work on.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "bower_components", "vendor", "target", "__pycache__",
  ".venv", "venv", ".tox", ".gradle", ".m2", ".cargo", ".rustup",
  ".cache", ".npm", ".pnpm", ".yarn", ".bun", ".next", ".nuxt", ".svelte-kit",
  ".terraform", ".idea", ".vscode", ".Trash",
]);

/**
 * How far below the root to look. VS Code defaults to 1; two levels covers the
 * layout that one misses — `workspace/apps/web`, `workspace/packages/api` —
 * while still bounding the walk on a container folder full of checkouts.
 */
export const DEFAULT_SCAN_DEPTH = 2;

/** True when `dir` is the working tree of a repository, worktree or submodule. */
export function isGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, ".git"));
}

export interface DiscoverOptions {
  /** Levels of subfolder to scan. 0 checks the root only. */
  maxDepth?: number;
  /** Overrides `IGNORED_DIRS` when given. */
  ignore?: ReadonlySet<string>;
}

export function discoverGitRepos(projectPath: string, options: DiscoverOptions = {}): GitRepoDiscovery {
  const root = resolve(projectPath);
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_DEPTH;
  const ignore = options.ignore ?? IGNORED_DIRS;

  if (isGitRepo(root)) {
    return {
      root,
      rootIsRepo: true,
      repos: [{ path: root, name: basename(root) || root, relative: "." }],
    };
  }

  const repos: GitRepoCandidate[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable: not an error, just nothing to offer from here
    }
    for (const entry of entries) {
      if (entry === ".git" || ignore.has(entry)) continue;
      const full = resolve(dir, entry);
      try {
        // Symlinks are skipped rather than resolved: a link into a parent is a
        // cycle, and a link out of the project would offer a repository the
        // path guard would then refuse to scope to.
        if (!lstatSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (isGitRepo(full)) {
        repos.push({ path: full, name: entry, relative: relative(root, full).split(sep).join("/") });
        continue; // its submodules belong to it, not beside it
      }
      walk(full, depth + 1);
    }
  };

  walk(root, 1);
  // Shallowest first, then alphabetical: the order a picker should list them.
  repos.sort((a, b) => {
    const byDepth = a.relative.split("/").length - b.relative.split("/").length;
    return byDepth !== 0 ? byDepth : a.relative.localeCompare(b.relative);
  });
  return { root, rootIsRepo: false, repos };
}
