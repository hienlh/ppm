/**
 * The walk behind a project's flat file index, and what is served from it.
 *
 * Runs in the file index walk process (`file-index-walk-process.ts`), or on the main thread where none
 * could be started. It must stay free of any import that reaches the config store or the
 * database: the filter arrives already resolved.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileEntry } from "../../types/project.ts";
import { ok } from "../../types/api.ts";
import { REMOTE_FILE_SEARCH_FROM_ENTRIES } from "../../shared/file-index-limits.ts";
import { matchesGlob } from "../file-glob.ts";

/**
 * The most entries a walk lists. A folder of 355 worktree checkouts held 1.17M, and every walk of
 * it left the walking worker holding 1-3 GB. Past this the walk stops and the build says so, the
 * way the file watcher stops at its directory budget.
 */
export const MAX_INDEX_ENTRIES = 300_000;

/**
 * Entries of a list too long to send that are still serialised, for readers that only want a
 * taste of the project (the voice context reads at most 400 names from the first 4 MB).
 */
export const INDEX_SAMPLE_ENTRIES = 20_000;

/** A project's filter, resolved from the config store by whoever asks for the walk. */
export interface IndexFilter {
  /** filesExclude + searchExclude: hard excludes, never listed. */
  exclude: string[];
  /** Whether gitignored files are flagged `isIgnored` (they are still listed). */
  useIgnoreFiles: boolean;
}

/**
 * A walk, ready to serve. A list short enough to send carries the whole `/files/index` response
 * body — envelope included, so the route sends it as it is — plain and gzipped. A `large` list is
 * never sent: it has no gzip, its `json` holds only its first `INDEX_SAMPLE_ENTRIES` entries, and
 * the whole list travels as `compact` (see `encodeCompact`) to whatever searches it.
 */
export interface IndexBuild {
  json: Uint8Array<ArrayBuffer>;
  gzip: Uint8Array<ArrayBuffer>;
  /** Equal hashes mean the same paths, types and ignore flags in the same order. */
  hash: string;
  count: number;
  walkMs: number;
  /** `REMOTE_FILE_SEARCH_FROM_ENTRIES` entries or more: searched on the server, never sent. */
  large?: boolean;
  /** The walk stopped at `MAX_INDEX_ENTRIES`. */
  truncated?: boolean;
  /** The whole list of a large build, as `encodeCompact` writes it. */
  compact?: Uint8Array<ArrayBuffer>;
  /** Peak resident memory of the process that walked, when it was a walk process of its own. */
  peakMB?: number;
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
 * back every `entriesPerSlice` entries, so whatever else runs there is not kept waiting. Stops at
 * `maxEntries`, and says so.
 */
export async function walkIndex(
  rootPath: string,
  filter: IndexFilter,
  entriesPerSlice: number,
  maxEntries: number = MAX_INDEX_ENTRIES,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
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
    if (results.length >= maxEntries) return { entries: results, truncated: true };
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
  return { entries: results, truncated: false };
}

/** The response body for `entries` and a hash of it; gzipping is left to the caller's thread. */
export function serializeIndex(entries: FileEntry[]): { json: Uint8Array<ArrayBuffer>; hash: string } {
  const json = new TextEncoder().encode(JSON.stringify(ok(entries)));
  return { json, hash: Bun.hash(json).toString(16) };
}

/**
 * Everything a build holds but its gzip and timing, which each thread adds its own way. A large
 * list is not serialised whole — 1.17M entries were 160 MB of JSON that no browser downloads,
 * since the route answers `tooLarge` — it gets a sample body and the compact encoding instead.
 */
export function prepareBuild(entries: FileEntry[], truncated: boolean): Omit<IndexBuild, "gzip" | "walkMs"> {
  if (entries.length < REMOTE_FILE_SEARCH_FROM_ENTRIES) {
    return { ...serializeIndex(entries), count: entries.length, large: false, truncated };
  }
  const compact = encodeCompact(entries);
  const { json } = serializeIndex(entries.slice(0, INDEX_SAMPLE_ENTRIES));
  return { json, compact, hash: Bun.hash(compact).toString(16), count: entries.length, large: true, truncated };
}

/** The kind of each record in `encodeCompact`. */
const KIND_DIR = "d";
const KIND_FILE = "f";
const KIND_IGNORED = "i";
const RECORD_SEPARATOR = "\u0000";

/**
 * A list as `<kind><path>` records separated by NUL, the one character no path on any platform
 * can hold. `name` is not stored: it is the path after its last slash.
 */
export function encodeCompact(entries: FileEntry[]): Uint8Array<ArrayBuffer> {
  const records = new Array<string>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    records[i] = (e.type === "directory" ? KIND_DIR : e.isIgnored ? KIND_IGNORED : KIND_FILE) + e.path;
  }
  return new TextEncoder().encode(records.join(RECORD_SEPARATOR));
}

export function decodeCompact(compact: Uint8Array): FileEntry[] {
  if (compact.length === 0) return [];
  const records = new TextDecoder().decode(compact).split(RECORD_SEPARATOR);
  const entries = new Array<FileEntry>(records.length);
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const kind = record[0];
    const path = record.slice(1);
    const name = path.slice(path.lastIndexOf("/") + 1);
    entries[i] = kind === KIND_DIR
      ? { path, name, type: "directory" }
      : { path, name, type: "file", ...(kind === KIND_IGNORED && { isIgnored: true }) };
  }
  return entries;
}

/** A build's whole list, from whichever form it holds it in. */
export function buildEntries(build: Pick<IndexBuild, "json" | "compact">): FileEntry[] {
  if (build.compact) return decodeCompact(build.compact);
  return JSON.parse(new TextDecoder().decode(build.json)).data as FileEntry[];
}
