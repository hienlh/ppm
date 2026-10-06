/**
 * file-list-index.service.ts
 * Lazy-load file tree listing and flat index building for palette/search.
 * Implements listDir() (1-level) and buildIndex() (recursive) with filter support.
 * Index results are cached per project path; a file change marks them stale (see IndexEntry).
 * The walk itself runs on the file index worker (file-index/), off the thread serving requests.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Ignore } from "ignore";
import type { FileDirEntry, FileEntry } from "../types/project.ts";
import { matchesGlob, resolveFilter } from "./file-filter.service.ts";
import { SecurityError, NotFoundError } from "./file.service.ts";
import { loadGitignore, type IndexBuild } from "./file-index/index-walk.ts";
import { fileIndexRunner } from "./file-index/file-index-runner.ts";
import type { SearchKind } from "./file-index/index-search.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("file-index");

// ---------------------------------------------------------------------------
// Index cache keyed by absolute project path
// ---------------------------------------------------------------------------

/**
 * One project's index. A file change marks it `stale` instead of dropping it, and the list is
 * walked again in the background a second later (see `refreshDelay`), so the palette opens on a
 * list that is already current. A request that finds it stale is answered with the rebuild if
 * that lands within `REBUILD_GRACE_MS`, and with the list already held otherwise. It used to be
 * dropped, so the explorer's refetch after every change walked the project on the request
 * itself — nxsys-workspace (181k entries) took 6.2 s per walk, and a session writing test
 * artefacts into it kept the server frozen until the supervisor killed it.
 */
interface IndexEntry {
  build: IndexBuild | null;
  /** Something under the project changed since `build` was walked. */
  stale: boolean;
  /** The walk under way, shared by every request that arrives while it runs. */
  building: Promise<IndexBuild> | null;
  /**
   * A request found a change that landed after the running walk began, which that walk may
   * have passed by — so walk once more as soon as it ends, instead of after `refreshDelay`.
   * Only for a project quick to walk (`QUICK_WALK_MS`); a slow one keeps to its schedule.
   */
  rewalk: boolean;
  /** The background walk a change scheduled. */
  refreshTimer: ReturnType<typeof setTimeout> | null;
  /** When the last walk ended, and how long it took: what spaces background walks out. */
  lastWalkEndedAt: number;
  lastWalkMs: number;
  /** A walk took `SLOW_WALK_LOG_MS` or more and said so at INFO; later slow walks stay at DEBUG. */
  slowLogged?: boolean;
}

/** A walk this long is worth a line at INFO, once per project: it keeps a core busy that long. */
const SLOW_WALK_LOG_MS = 5_000;

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
  const entry = indexCache.get(projectPath);
  if (entry?.refreshTimer) clearTimeout(entry.refreshTimer);
  indexCache.delete(projectPath);
}

/** A file changed: keep serving the index held, and walk it again in the background. */
export function markIndexStale(projectPath: string): void {
  const entry = indexCache.get(projectPath);
  if (!entry) return;
  entry.stale = true;
  scheduleRefresh(projectPath, entry);
}

/**
 * Walk a project nobody has asked about yet, so its first palette opens on a ready list. The
 * walk runs on the index worker; a failure is left to the first request to report.
 */
export function warmIndex(projectPath: string): void {
  if (indexCache.has(projectPath)) return;
  buildIndex(projectPath).catch(() => {});
}

/** Clear all cached indexes (e.g. for tests) */
export function clearIndexCache(): void {
  for (const entry of indexCache.values()) {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
  }
  indexCache.clear();
}

/**
 * How long after a change to walk again. A second, so a burst of writes costs one walk — but no
 * sooner after the last walk ended than that walk took, so a project as slow as nxsys-workspace
 * (~7 s) keeps the worker busy at most half the time while a session writes into it without end.
 */
export function refreshDelay(now: number, lastWalkEndedAt: number, lastWalkMs: number): number {
  return Math.max(REFRESH_AFTER_CHANGE_MS, lastWalkEndedAt + lastWalkMs - now);
}

function scheduleRefresh(projectPath: string, entry: IndexEntry): void {
  // With no list yet the first request walks, and a walk under way reschedules when it ends.
  // Starting a walk and dropping the entry both clear the timer, so one that fires has work to do.
  if (entry.refreshTimer || !entry.build || entry.building) return;
  entry.refreshTimer = setTimeout(() => {
    entry.refreshTimer = null;
    startBuild(projectPath, entry);
  }, refreshDelay(Date.now(), entry.lastWalkEndedAt, entry.lastWalkMs));
  entry.refreshTimer.unref?.();
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
 * How long a request for a stale index waits for the rebuild before it is answered with the
 * list already held. Most projects are walked well inside it — PPM's own 3.2k entries take
 * ~80 ms — so a file just created is in the palette the first time it opens. nxsys-workspace
 * (181k entries, ~7 s) is answered with the list it had, and `files:index-changed` follows.
 */
const REBUILD_GRACE_MS = 1000;

/** See `refreshDelay`. */
const REFRESH_AFTER_CHANGE_MS = 1000;

/**
 * The slowest walk a request waits for. A slower project is answered with the list it has at
 * once and rebuilt on its own schedule, and whatever is showing the list gets the rebuild when
 * `files:index-changed` says it landed. Measured on a 186k-entry project written into every
 * 50 ms: waiting for its ~1 s walks made every palette open take 969 ms (p50), and walking again
 * straight after each walk that a request found stale kept the worker walking without a break.
 */
const QUICK_WALK_MS = 250;

/**
 * Flat index of all files in the project for palette/search, as the `/files/index` response.
 * Applies filesExclude + searchExclude + optional gitignore.
 *
 * Only a project with no list yet waits for the whole walk. A stale list of a project that is
 * quick to walk is replaced if its rebuild lands within `graceMs`; any other stale list is
 * returned as it is, the rebuild carrying on behind it — see `IndexEntry`. `graceMs` 0 answers
 * with the held list at once.
 */
export function buildIndex(projectPath: string, graceMs = REBUILD_GRACE_MS): Promise<IndexBuild> {
  let entry = indexCache.get(projectPath);
  if (!entry) {
    entry = { build: null, stale: true, building: null, rewalk: false, refreshTimer: null, lastWalkEndedAt: 0, lastWalkMs: 0 };
    indexCache.set(projectPath, entry);
  }
  const held = entry.build;
  const waits = !held || entry.lastWalkMs <= QUICK_WALK_MS;
  if (entry.stale) {
    // A slow list is refreshed on its schedule; this only re-arms one a failed walk left unset.
    if (!waits) scheduleRefresh(projectPath, entry);
    else if (entry.building) entry.rewalk = true;
    else startBuild(projectPath, entry);
  }
  const building = entry.building;
  if (!building) return Promise.resolve(held!);
  if (!held) return building;
  if (graceMs <= 0 || !waits) return Promise.resolve(held);
  const graceOver = new Promise<IndexBuild>((resolve) => setTimeout(() => resolve(held), graceMs));
  return Promise.race([building.catch(() => held), graceOver]);
}

/**
 * The best `limit` entries of the project's list for `query`, best first, searched where the list
 * is held (see `index-search.ts`) — for a project whose list is too long to send to a browser.
 * Searches the list `buildIndex` would answer with, and never waits for a rebuild: this is asked
 * once per keystroke.
 */
export async function searchFileIndex(projectPath: string, query: string, kind: SearchKind, limit: number): Promise<FileEntry[]> {
  const build = await buildIndex(projectPath, 0);
  return fileIndexRunner.search(projectPath, build, query, kind, limit);
}

function startBuild(projectPath: string, entry: IndexEntry): Promise<IndexBuild> {
  const previous = entry.build;
  if (entry.refreshTimer) {
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = null;
  }
  // A change from here on may land behind the walk, so it has to leave the list stale again.
  entry.stale = false;
  entry.rewalk = false;
  const filter = resolveFilter(projectPath);
  const build = fileIndexRunner.run(projectPath, {
    exclude: [...filter.filesExclude, ...filter.searchExclude],
    useIgnoreFiles: filter.useIgnoreFiles,
  }).then(
    (next) => {
      entry.building = null;
      entry.build = next;
      entry.lastWalkEndedAt = Date.now();
      entry.lastWalkMs = next.walkMs;
      // A rebuild follows every burst of file changes, so only a project's first walk and the
      // first one that turns slow are worth INFO.
      const slowNow = next.walkMs >= SLOW_WALK_LOG_MS && !entry.slowLogged;
      if (slowNow) entry.slowLogged = true;
      const line = `indexed ${projectPath}: ${next.count} entries in ${Math.round(next.walkMs)} ms (` +
        `${previous ? `changed=${previous.hash !== next.hash}, ` : ""}${fileIndexRunner.onMainThread ? "main thread" : "worker"})`;
      if (!previous || slowNow) log.info(line);
      else log.debug(line);
      if (previous) {
        const changed = previous.hash !== next.hash;
        for (const listener of rebuiltListeners) listener(projectPath, changed);
      }
      if (entry.rewalk) startBuild(projectPath, entry);
      else if (entry.stale) scheduleRefresh(projectPath, entry);
      return next;
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
    build.catch((e) => log.warn(`rebuilding ${projectPath} failed: ${(e as Error).message}`));
  }
  return build;
}
