/**
 * file-list-index.service.ts
 * Lazy-load file tree listing and flat index building for palette/search.
 * Implements listDir() (1-level) and buildIndex() (recursive) with filter support.
 * Index results are cached per project path; a file change marks them stale (see IndexEntry).
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileEntry, FileDirEntry } from "../types/project.ts";
import { matchesGlob, resolveFilter } from "./file-filter.service.ts";
import { SecurityError, NotFoundError } from "./file.service.ts";

// ---------------------------------------------------------------------------
// Index cache keyed by absolute project path
// ---------------------------------------------------------------------------

/**
 * One project's index. A file change marks it `stale` instead of dropping it; the next request
 * starts a rebuild, and is answered with the list already held if that rebuild takes longer
 * than `REBUILD_GRACE_MS`. It used to be dropped, so the explorer's refetch after every change
 * walked the project on the request itself — nxsys-workspace (181k entries) took 6.2 s per walk,
 * and a session writing test artefacts into it kept the server frozen until the supervisor
 * killed it.
 */
interface IndexEntry {
  entries: FileEntry[] | null;
  /** Something under the project changed since `entries` was walked. */
  stale: boolean;
  /** The walk under way, shared by every request that arrives while it runs. */
  building: Promise<FileEntry[]> | null;
  /**
   * A request found a change that landed after the running walk began, which that walk may
   * have passed by — so walk once more when it ends. Only a request sets it: a change nobody
   * asks about costs nothing, however long a session keeps writing.
   */
  rewalk: boolean;
}

const indexCache = new Map<string, IndexEntry>();

type RebuiltListener = (projectPath: string, changed: boolean) => void;
const rebuiltListeners = new Set<RebuiltListener>();

/**
 * Called after each background rebuild — one that replaced a list already being served — with
 * whether its paths differ. Content-only churn (a log being appended to) rebuilds to the same
 * list, and nothing downstream needs to hear about that.
 */
export function onIndexRebuilt(listener: RebuiltListener): () => void {
  rebuiltListeners.add(listener);
  return () => { rebuiltListeners.delete(listener); };
}

/**
 * Drop a project's index, so the next request waits for a fresh walk. For filter changes: the
 * list held was built with the old filters, so it is wrong rather than merely old.
 */
export function invalidateIndexCache(projectPath: string): void {
  indexCache.delete(projectPath);
}

/** A file changed: keep serving the index held, and rebuild it on the next request. */
export function markIndexStale(projectPath: string): void {
  const entry = indexCache.get(projectPath);
  if (entry) entry.stale = true;
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
  if (!abs.startsWith(projectPath + sep) && abs !== projectPath) {
    throw new SecurityError("Path traversal not allowed");
  }
}

// ---------------------------------------------------------------------------
// listDir — single directory level
// ---------------------------------------------------------------------------

/** Per-request listing context: filter + gitignore loaded once, reused across paths */
interface ListContext {
  filter: ReturnType<typeof resolveFilter>;
  ig: Ignore | null;
}

function loadListContext(projectPath: string): ListContext {
  const filter = resolveFilter(projectPath);
  const ig = filter.useIgnoreFiles ? loadGitignore(projectPath) : null;
  return { filter, ig };
}

/**
 * List one directory level for lazy-load file tree.
 * Applies filesExclude patterns from resolved filter.
 * Marks entries as isIgnored based on .gitignore (informational — still listed).
 */
export function listDir(projectPath: string, relPath: string): FileDirEntry[] {
  return listDirWithContext(projectPath, relPath, loadListContext(projectPath));
}

/**
 * List multiple directory levels in one call (single filter/gitignore load).
 * Per-path failures land in `error` without failing the whole batch.
 */
export function listDirBatch(
  projectPath: string,
  paths: string[],
): { path: string; entries?: FileDirEntry[]; error?: string }[] {
  const ctx = loadListContext(projectPath);
  return paths.map((p) => {
    try {
      return { path: p, entries: listDirWithContext(projectPath, p, ctx) };
    } catch (e) {
      return { path: p, error: (e as Error).message };
    }
  });
}

function listDirWithContext(projectPath: string, relPath: string, { filter, ig }: ListContext): FileDirEntry[] {
  if (relPath) assertWithinProject(relPath, projectPath);

  const absDir = relPath ? resolve(projectPath, relPath) : projectPath;
  if (!existsSync(absDir)) throw new NotFoundError(`Directory not found: ${relPath || "/"}`);

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
 * How many directory entries the walk handles before handing the event loop back. An entry
 * costs a few glob tests and two gitignore checks — ~34 µs on nxsys-workspace — so a slice is
 * about 10 ms, which is as long as a health probe or a chat stream waits. Counted rather than
 * timed so that how often it yields does not depend on the machine.
 */
const ENTRIES_PER_SLICE = 256;

/**
 * How long a request for a stale index waits for the rebuild before it is answered with the
 * list already held. Most projects are walked well inside it — PPM's own 3.2k entries take
 * ~80 ms — so a file just created is in the palette the first time it opens. nxsys-workspace
 * (181k entries, ~7.3 s) is answered with the list it had, and `files:index-changed` follows.
 */
const REBUILD_GRACE_MS = 1000;

/**
 * Flat index of all files in the project for palette/search.
 * Applies filesExclude + searchExclude + optional gitignore.
 *
 * Only a project with no list yet waits for the whole walk. A stale list is replaced if its
 * rebuild lands within `graceMs` and returned as it is otherwise, the rebuild carrying on
 * behind it — see `IndexEntry`. `graceMs` 0 answers with the held list at once.
 */
export function buildIndex(projectPath: string, graceMs = REBUILD_GRACE_MS): Promise<FileEntry[]> {
  let entry = indexCache.get(projectPath);
  if (!entry) {
    entry = { entries: null, stale: true, building: null, rewalk: false };
    indexCache.set(projectPath, entry);
  }
  if (entry.stale) {
    if (entry.building) entry.rewalk = true;
    else startBuild(projectPath, entry);
  }
  const held = entry.entries;
  const building = entry.building;
  if (!building) return Promise.resolve(held!);
  if (!held) return building;
  if (graceMs <= 0) return Promise.resolve(held);
  const graceOver = new Promise<FileEntry[]>((resolve) => setTimeout(() => resolve(held), graceMs));
  return Promise.race([building.catch(() => held), graceOver]);
}

function startBuild(projectPath: string, entry: IndexEntry): Promise<FileEntry[]> {
  const previous = entry.entries;
  // A change from here on may land behind the walk, so it has to leave the list stale again.
  entry.stale = false;
  entry.rewalk = false;
  const build = walkIndex(projectPath).then(
    (entries) => {
      entry.building = null;
      entry.entries = entries;
      if (previous) {
        const changed = !sameEntries(previous, entries);
        for (const listener of rebuiltListeners) listener(projectPath, changed);
      }
      if (entry.rewalk) startBuild(projectPath, entry);
      return entries;
    },
    (e) => {
      entry.building = null;
      entry.stale = true;
      throw e;
    },
  );
  entry.building = build;
  // Nobody awaits a background rebuild, so its failure is only logged; the old list stays.
  if (previous) {
    build.catch((e) => console.warn(`[file-index] rebuilding ${projectPath} failed: ${(e as Error).message}`));
  }
  return build;
}

/** Same paths, types and ignore flags in the same order — everything a client renders. */
function sameEntries(a: FileEntry[], b: FileEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path || x.type !== y.type || x.isIgnored !== y.isIgnored) return false;
  }
  return true;
}

async function walkIndex(rootPath: string): Promise<FileEntry[]> {
  const filter = resolveFilter(rootPath);
  const ig = filter.useIgnoreFiles ? loadGitignore(rootPath) : null;
  const allExclude = [...filter.filesExclude, ...filter.searchExclude];
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
    if (++sinceYield >= ENTRIES_PER_SLICE) {
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
