/**
 * file-filter.service.ts
 * Resolves VS Code-style file exclude patterns for lazy-load file tree.
 * Precedence: hardcoded defaults < global config < per-project override (last wins).
 */

import type { FileFilterConfig } from "../types/project.ts";
import { configService } from "./config.service.ts";

/** Patterns always excluded from tree listing (cannot be overridden by config) */
export const HARDCODED_FILES_EXCLUDE = [
  "**/.git",
  "**/.DS_Store",
  "**/Thumbs.db",
];

/** Patterns always excluded from index/search */
export const HARDCODED_SEARCH_EXCLUDE = [
  "**/node_modules",
  "**/dist",
  "**/build",
  "**/.next",
  "**/target",
  "**/.venv",
  "**/.cache",
];

export interface ResolvedFilter {
  /** Combined filesExclude: hardcoded + global + project (deduped) */
  filesExclude: string[];
  /** Combined searchExclude: hardcoded + global + project (deduped) */
  searchExclude: string[];
  /** Whether to apply gitignore rules */
  useIgnoreFiles: boolean;
}

/**
 * Resolve final filter config for a project path.
 * Merges: hardcoded defaults ∪ global config ∪ per-project override.
 */
export function resolveFilter(projectPath: string): ResolvedFilter {
  const globalFilesExclude = configService.getFilesExclude();
  const globalSearchExclude = configService.getSearchExclude();
  const globalUseIgnoreFiles = configService.getUseIgnoreFiles();

  const projectSettings = configService.getProjectSettings(projectPath);
  const projectFilter: FileFilterConfig = projectSettings.files ?? {};

  // Merge arrays (dedup)
  const filesExclude = dedup([
    ...HARDCODED_FILES_EXCLUDE,
    ...globalFilesExclude,
    ...(projectFilter.filesExclude ?? []),
  ]);

  const searchExclude = dedup([
    ...HARDCODED_SEARCH_EXCLUDE,
    ...globalSearchExclude,
    ...(projectFilter.searchExclude ?? []),
  ]);

  // Per-project useIgnoreFiles overrides global if set
  const useIgnoreFiles = projectFilter.useIgnoreFiles !== undefined
    ? projectFilter.useIgnoreFiles
    : globalUseIgnoreFiles;

  return { filesExclude, searchExclude, useIgnoreFiles };
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Check if a relative path matches any of the given glob patterns.
 * Uses simple pattern-to-regex conversion (no external lib needed).
 * Patterns follow VS Code glob semantics: ** crosses dirs, * stays in one segment.
 */
export function matchesGlob(relPath: string, patterns: string[]): boolean {
  // Normalize path separators to forward slash
  const normalized = relPath.split("\\").join("/");
  return patterns.some((pattern) => matchSingleGlob(normalized, pattern));
}

function matchSingleGlob(relPath: string, pattern: string): boolean {
  // Strip leading **/ for simpler matching — handled by regex
  const re = globPatternToRegex(pattern);
  return re.test(relPath);
}

/**
 * Convert a VS Code-style glob pattern to a RegExp.
 * Cached per unique pattern string for performance.
 */
const regexCache = new Map<string, RegExp>();

function globPatternToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let p = pattern;
  // Normalize path separators
  p = p.split("\\").join("/");
  // Strip leading ./
  if (p.startsWith("./")) p = p.slice(2);

  // Leading `**/` should match zero-or-more path segments, INCLUDING root.
  // So `**/.git` matches both `.git` (at root) and `src/.git` (nested).
  // Strip `**/` prefix here so it doesn't force a leading path; we handle it via optional group below.
  const hasStarstarPrefix = p.startsWith("**/");
  if (hasStarstarPrefix) p = p.slice(3);

  const escaped = p
    .replace(/[.+^${}()|[\]]/g, "\\$&") // escape regex special chars (not * ?)
    .replace(/\*\*/g, "\x00")            // temp: ** placeholder
    .replace(/\*/g, "[^/]*")             // * = within one path segment
    .replace(/\x00/g, ".*")             // ** = any path
    .replace(/\?/g, "[^/]");            // ? = single non-slash char

  let re: RegExp;
  if (hasStarstarPrefix) {
    // `**/X` → match X at any depth including root: `(^|.*/)X(/|$)`
    re = new RegExp(`(^|.*/)${escaped}(/|$)`);
  } else if (p.includes("/")) {
    // Anchored pattern with explicit path
    re = new RegExp(`^${escaped}(/|$)`);
  } else {
    // Pattern with no slash (e.g. *.log) → match at any depth
    re = new RegExp(`(^|/)${escaped}(/|$)`);
  }

  regexCache.set(pattern, re);
  return re;
}
