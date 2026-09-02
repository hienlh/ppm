import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertAllowed, resolvePath } from "../fs-path-guard.service.ts";

/** Noise that would swamp a palette listing. */
const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const LIST_MAX_FILES = 200;
const LIST_MAX_DEPTH = 4;

/**
 * Breadth-first file listing for the command palette. Lists all files at each
 * level before descending, so root-level files (e.g. ~/.npmrc) are always
 * found before the limit is reached.
 */
export function list(dir: string): string[] {
  const resolved = resolvePath(dir);
  assertAllowed(resolved);

  const files: string[] = [];
  const queue: { path: string; depth: number }[] = [{ path: resolved, depth: 0 }];

  while (queue.length > 0 && files.length < LIST_MAX_FILES) {
    const { path: dirPath, depth } = queue.shift()!;
    if (depth > LIST_MAX_DEPTH) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip instead of failing the listing
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const full = resolve(dirPath, entry.name);
      if (entry.isFile()) {
        files.push(full);
        if (files.length >= LIST_MAX_FILES) return files;
      } else if (entry.isDirectory()) {
        queue.push({ path: full, depth: depth + 1 });
      }
    }
  }

  return files;
}
