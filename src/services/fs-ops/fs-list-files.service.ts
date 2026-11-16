import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { assertAllowed, resolvePath } from "../fs-path-guard.service.ts";

/** Noise that would swamp a palette listing. */
const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const LIST_MAX_FILES = 200;
const LIST_MAX_DEPTH = 4;
/** Directories read in parallel per level — same bound the browse listing uses. */
const READ_CONCURRENCY = 16;
/**
 * A dead network mount or sleeping disk can make one `readdir` hang for
 * minutes. The palette would rather return a short list than stall every
 * websocket on the server, so a slow directory is simply dropped.
 */
const READ_TIMEOUT_MS = 1_500;

async function readDirSafe(dirPath: string): Promise<Dirent[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Dirent[]>((r) => {
    timer = setTimeout(() => r([]), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      readdir(dirPath, { withFileTypes: true }).catch(() => [] as Dirent[]),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the palette needs to draw a directory: where it is, its folders, and the files under it. */
export interface FsListing {
  /** The directory as the host resolved it (`~` expanded, separators and `..` normalised). */
  dir: string;
  /** Its direct subfolders, absolute — empty ones included, which the file list cannot show. */
  dirs: string[];
  /** Files under it, breadth-first, at most `LIST_MAX_FILES`. */
  files: string[];
  /** The cap was reached, so files further on were never listed. */
  truncated: boolean;
}

/**
 * Breadth-first file listing for the command palette. Lists all files at each
 * level before descending, so root-level files (e.g. ~/.npmrc) are always
 * found before the limit is reached.
 */
export async function list(dir: string): Promise<string[]> {
  return (await listWithDirs(dir)).files;
}

/**
 * `list`, plus the resolved directory and its direct subfolders. The palette names each entry
 * relative to `dir`; without it the browser would have to guess what `~` or `..` became.
 */
export async function listWithDirs(dir: string): Promise<FsListing> {
  const resolved = resolvePath(dir);
  assertAllowed(resolved);

  const files: string[] = [];
  let dirs: string[] = [];
  let level = [resolved];

  for (let depth = 0; depth <= LIST_MAX_DEPTH && level.length && files.length < LIST_MAX_FILES; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(level.slice(i, i + READ_CONCURRENCY).map(readDirSafe));
      batch.forEach((entries, index) => {
        const dirPath = level[i + index]!;
        for (const entry of entries) {
          if (SKIP_NAMES.has(entry.name)) continue;
          const full = resolve(dirPath, entry.name);
          if (entry.isFile()) {
            if (files.length < LIST_MAX_FILES) files.push(full);
          } else if (entry.isDirectory()) {
            next.push(full);
          }
        }
      });
      if (depth === 0) dirs = next.slice(0, LIST_MAX_FILES);
      if (files.length >= LIST_MAX_FILES) return { dir: resolved, dirs, files: files.slice(0, LIST_MAX_FILES), truncated: true };
    }
    level = next;
  }

  // Stopped by the depth limit with folders still unread: their files were never listed either.
  return { dir: resolved, dirs, files, truncated: level.length > 0 };
}
