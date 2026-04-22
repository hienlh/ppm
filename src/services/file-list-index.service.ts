/**
 * file-list-index.service.ts
 * Lazy-load file tree listing and flat index building for palette/search.
 * Implements listDir() (1-level) and buildIndex() (recursive) with filter support.
 * Index results are cached per project path and invalidated on file changes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileEntry, FileDirEntry } from "../types/project.ts";
import { matchesGlob, resolveFilter } from "./file-filter.service.ts";
import { SecurityError, NotFoundError } from "./file.service.ts";

// ---------------------------------------------------------------------------
// Index cache keyed by absolute project path
// ---------------------------------------------------------------------------

const indexCache = new Map<string, FileEntry[]>();

/** Invalidate cached flat index for a project (called on file change events) */
export function invalidateIndexCache(projectPath: string): void {
  indexCache.delete(projectPath);
}

/** Clear all cached indexes (e.g. for tests) */
export function clearIndexCache(): void {
  indexCache.clear();
}

// ---------------------------------------------------------------------------
// Gitignore loader (shared utility)
// ---------------------------------------------------------------------------

function loadGitignore(projectPath: string): Ignore {
  const ig = ignore();
  const gitignorePath = join(projectPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, "utf-8");
      ig.add(content);
    } catch { /* unreadable — skip */ }
  }
  return ig;
}

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

function assertWithinProject(relPath: string, projectPath: string): void {
  const abs = resolve(projectPath, relPath);
  if (!abs.startsWith(projectPath + "/") && abs !== projectPath) {
    throw new SecurityError("Path traversal not allowed");
  }
}

// ---------------------------------------------------------------------------
// listDir — single directory level
// ---------------------------------------------------------------------------

/**
 * List one directory level for lazy-load file tree.
 * Applies filesExclude patterns from resolved filter.
 * Marks entries as isIgnored based on .gitignore (informational — still listed).
 */
export function listDir(projectPath: string, relPath: string): FileDirEntry[] {
  if (relPath) assertWithinProject(relPath, projectPath);

  const absDir = relPath ? resolve(projectPath, relPath) : projectPath;
  if (!existsSync(absDir)) throw new NotFoundError(`Directory not found: ${relPath || "/"}`);

  const filter = resolveFilter(projectPath);
  const ig = filter.useIgnoreFiles ? loadGitignore(projectPath) : null;

  let rawEntries;
  try { rawEntries = readdirSync(absDir, { withFileTypes: true }); }
  catch { return []; }

  const results: FileDirEntry[] = [];

  for (const entry of rawEntries) {
    const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const entryRelPosix = entryRel.split("\\").join("/");

    // Skip entries matching filesExclude (check full path and bare name)
    if (matchesGlob(entryRelPosix, filter.filesExclude)) continue;
    if (matchesGlob(entry.name, filter.filesExclude)) continue;

    // Gitignore flag (informational only — entry still included in list)
    let isIgnored = false;
    if (ig) {
      const checkPath = entry.isDirectory() ? `${entryRelPosix}/` : entryRelPosix;
      isIgnored = ig.ignores(checkPath) || ig.ignores(entryRelPosix);
    }

    results.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      isIgnored,
    });
  }

  // Sort: directories first, then alphabetically
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

// ---------------------------------------------------------------------------
// buildIndex — recursive flat file list
// ---------------------------------------------------------------------------

/**
 * Build flat index of all files in project for palette/search.
 * Applies filesExclude + searchExclude + optional gitignore.
 * Result is cached; call invalidateIndexCache(projectPath) to bust.
 */
export function buildIndex(projectPath: string): FileEntry[] {
  const cached = indexCache.get(projectPath);
  if (cached) return cached;

  const filter = resolveFilter(projectPath);
  const ig = filter.useIgnoreFiles ? loadGitignore(projectPath) : null;
  const allExclude = [...filter.filesExclude, ...filter.searchExclude];

  const entries: FileEntry[] = [];
  walkForIndex(projectPath, projectPath, allExclude, ig, entries);

  indexCache.set(projectPath, entries);
  return entries;
}

function walkForIndex(
  rootPath: string,
  dirPath: string,
  allExclude: string[],
  ig: Ignore | null,
  results: FileEntry[],
): void {
  let dirEntries;
  try { dirEntries = readdirSync(dirPath, { withFileTypes: true }); }
  catch { return; }

  for (const entry of dirEntries) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relative(rootPath, fullPath);
    const relPosix = relPath.split("\\").join("/");

    // Apply glob exclusion (check full relative path and bare entry name)
    // These are HARD excludes — .git, node_modules, dist, etc.
    if (matchesGlob(relPosix, allExclude)) continue;
    if (matchesGlob(entry.name, allExclude)) continue;

    // Apply gitignore rules — SOFT exclude for files (include with isIgnored flag),
    // HARD exclude for directories (skip recursion to avoid walking huge gitignored dirs).
    let isIgnored = false;
    if (ig) {
      const checkPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
      isIgnored = ig.ignores(checkPath) || ig.ignores(relPosix);
      if (isIgnored && entry.isDirectory()) continue;
    }

    if (entry.isDirectory()) {
      results.push({ path: relPosix, name: entry.name, type: "directory" });
      walkForIndex(rootPath, fullPath, allExclude, ig, results);
    } else {
      results.push({ path: relPosix, name: entry.name, type: "file", ...(isIgnored && { isIgnored: true }) });
    }
  }
}
