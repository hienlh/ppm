import { resolve, basename } from "node:path";
import { readdirSync, existsSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";

export interface GitDir {
  path: string;
  name: string;
}

/** Directories to never descend into (perf + irrelevant). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "vendor", "dist", "build",
  ".cache", ".npm", ".pnpm", ".yarn", "__pycache__", ".venv", "venv",
  ".Trash", "Library", "Applications", ".local", ".config",
]);

/**
 * In-memory cache: root path → list of git dirs found under it.
 * Populated on first deep scan, reused for subsequent queries.
 */
const cache = new Map<string, { dirs: GitDir[]; timestamp: number }>();

/** Cache TTL: 5 minutes */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Recursively find all directories containing `.git` under `root`.
 * Once a .git dir is found, we don't descend further into it (projects don't nest).
 */
function scanGitDirs(root: string, maxDepth: number): GitDir[] {
  const results: GitDir[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const full = resolve(dir, entry);
      try {
        // Skip symlinks to avoid cycles
        if (lstatSync(full).isSymbolicLink()) continue;
        if (!statSync(full).isDirectory()) continue;

        if (existsSync(resolve(full, ".git"))) {
          results.push({ path: full, name: entry });
          // Don't recurse into a git repo — nested repos are rare
        } else {
          walk(full, depth + 1);
        }
      } catch { /* skip unreadable */ }
    }
  }

  // Check if root itself is a git repo
  if (existsSync(resolve(root, ".git"))) {
    results.push({ path: root, name: basename(root) });
  } else {
    walk(root, 0);
  }

  return results;
}

/**
 * Get git directories under `root`, using cache when available.
 * @param root  Directory to search (defaults to home dir)
 * @param maxDepth  Max recursion depth (default 4)
 */
export function getGitDirs(root?: string, maxDepth = 4): GitDir[] {
  const dir = resolve(root ?? homedir());

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }

  const cached = cache.get(dir);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.dirs;
  }

  const dirs = scanGitDirs(dir, maxDepth);
  cache.set(dir, { dirs, timestamp: Date.now() });
  return dirs;
}

/**
 * Filter cached/scanned git dirs by a query string (fuzzy path match).
 */
export function searchGitDirs(query: string, root?: string, maxDepth = 4): GitDir[] {
  const all = getGitDirs(root, maxDepth);
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter(
    (d) => d.path.toLowerCase().includes(q) || d.name.toLowerCase().includes(q),
  );
}

/** Invalidate cache for a specific root (e.g. after adding a project). */
export function invalidateGitDirCache(root?: string): void {
  if (root) {
    cache.delete(resolve(root));
  } else {
    cache.clear();
  }
}
