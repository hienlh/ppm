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

// Matching lives in its own module so the file index worker can use it without the config store.
export { matchesGlob } from "./file-glob.ts";
