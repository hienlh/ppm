/**
 * The walk behind a project's flat file index, and what is served from it.
 *
 * Runs on the file index worker (`file-index-worker.ts`), or on the main thread where no worker
 * could be started. It must stay free of any import that reaches the config store or the
 * database: the filter arrives already resolved.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileEntry } from "../../types/project.ts";
import { ok } from "../../types/api.ts";
import { matchesGlob } from "../file-glob.ts";

/** A project's filter, resolved from the config store by whoever asks for the walk. */
export interface IndexFilter {
  /** filesExclude + searchExclude: hard excludes, never listed. */
  exclude: string[];
  /** Whether gitignored files are flagged `isIgnored` (they are still listed). */
  useIgnoreFiles: boolean;
}

/**
 * A walk, ready to serve: the whole `/files/index` response body — envelope included, so the
 * route sends it as it is — plain and gzipped, and a hash that says whether the list moved.
 */
export interface IndexBuild {
  json: Uint8Array<ArrayBuffer>;
  gzip: Uint8Array<ArrayBuffer>;
  /** Of `json`. Equal hashes mean the same paths, types and ignore flags in the same order. */
  hash: string;
  count: number;
  walkMs: number;
}

export function loadGitignore(projectPath: string): Ignore {
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

/**
 * Flat list of everything under `rootPath` that the filter keeps, depth-first. Hands its thread
 * back every `entriesPerSlice` entries, so whatever else runs there is not kept waiting.
 */
export async function walkIndex(rootPath: string, filter: IndexFilter, entriesPerSlice: number): Promise<FileEntry[]> {
  const ig = filter.useIgnoreFiles ? loadGitignore(rootPath) : null;
  const allExclude = filter.exclude;
  const results: FileEntry[] = [];

  // Depth-first on an explicit stack, in the order the recursive walk it replaces produced.
  const stack: { dirPath: string; dirEntries: Dirent[]; next: number }[] = [];
  const enter = (dirPath: string) => {
    try { stack.push({ dirPath, dirEntries: readdirSync(dirPath, { withFileTypes: true }), next: 0 }); }
    catch { /* unreadable — skip */ }
  };
  enter(rootPath);

  let sinceYield = 0;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const entry = frame.dirEntries[frame.next++];
    if (!entry) {
      stack.pop();
      continue;
    }
    if (++sinceYield >= entriesPerSlice) {
      sinceYield = 0;
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    const fullPath = join(frame.dirPath, entry.name);
    const relPath = relative(rootPath, fullPath);
    const relPosix = relPath.split("\\").join("/");

    // Apply glob exclusion (check full relative path and bare entry name)
    // These are HARD excludes — .git, node_modules, dist, etc.
    if (matchesGlob(relPosix, allExclude)) continue;
    if (matchesGlob(entry.name, allExclude)) continue;

    // Apply gitignore rules — SOFT exclude only (mark with isIgnored flag).
    // Huge dirs like node_modules/dist/build are already hard-excluded by glob above.
    let isIgnored = false;
    if (ig) {
      const checkPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
      isIgnored = ig.ignores(checkPath) || ig.ignores(relPosix);
    }

    if (entry.isDirectory()) {
      results.push({ path: relPosix, name: entry.name, type: "directory" });
      enter(fullPath);
    } else {
      results.push({ path: relPosix, name: entry.name, type: "file", ...(isIgnored && { isIgnored: true }) });
    }
  }
  return results;
}

/** The response body for `entries` and a hash of it; gzipping is left to the caller's thread. */
export function serializeIndex(entries: FileEntry[]): { json: Uint8Array<ArrayBuffer>; hash: string } {
  const json = new TextEncoder().encode(JSON.stringify(ok(entries)));
  return { json, hash: Bun.hash(json).toString(16) };
}
