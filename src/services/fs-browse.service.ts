import { readdirSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  assertAllowed,
  isAllowedPath,
  resolvePath,
} from "./fs-path-guard.service.ts";
import { isHiddenName } from "./fs-ops/fs-hidden-names.ts";
import { kindOfStats, type EntryKind } from "./fs-ops/fs-ops-stat.service.ts";

// Re-exported so existing importers keep a single filesystem entry point.
export { isAllowedPath, resolvePath };
export {
  readSystemFileSync as readSystemFile,
  writeSystemFile,
} from "./fs-ops/fs-ops-read-write.service.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  path: string;
  /** Coarse type kept for existing consumers; `kind` carries the detail. */
  type: "file" | "directory";
  kind: EntryKind;
  size?: number;
  modified: string;
}

export interface BrowseResult {
  entries: BrowseEntry[];
  current: string;
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
  /** Platform path separator, so the client can render native paths. */
  sep: string;
  /** True when the directory held more entries than the listing cap. */
  truncated?: boolean;
}

export interface BrowseOptions {
  showHidden?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const LIST_MAX_FILES = 200;
const LIST_MAX_DEPTH = 4;
/** Listing cap — beyond this the UI is unusable and the scan gets expensive. */
const BROWSE_MAX_ENTRIES = 5_000;
/** Parallel stat calls; enough to hide latency, few enough to stay polite. */
const STAT_CONCURRENCY = 16;
/**
 * A dead SMB share, sleeping USB disk or OneDrive placeholder can make a
 * single stat hang for minutes. The browse answer must still arrive, so a
 * slow entry is reported with an unknown kind instead of holding the request.
 */
const STAT_TIMEOUT_MS = 1_500;

// ── Browse ─────────────────────────────────────────────────────────

async function statEntry(fullPath: string, name: string): Promise<BrowseEntry | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), STAT_TIMEOUT_MS);
  });
  const stats = await Promise.race([lstat(fullPath).catch(() => "error" as const), timeout]);
  // Clearing matters: a listing of thousands of entries would otherwise hold
  // thousands of live timers until they each fire.
  clearTimeout(timer);

  if (stats === "error") return null; // unreadable — skipped, never fatal
  if (stats === "timeout") {
    return {
      name,
      path: fullPath,
      type: "file",
      kind: "unknown",
      modified: new Date(0).toISOString(),
    };
  }
  const kind = kindOfStats(stats);
  return {
    name,
    path: fullPath,
    type: kind === "directory" ? "directory" : "file",
    kind,
    size: kind === "file" ? stats.size : undefined,
    modified: stats.mtime.toISOString(),
  };
}

/** Run `worker` over `items` with a fixed number of workers in flight. */
async function mapBounded<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** List entries of a single directory (1 level, no symlink descent). */
export async function browse(dirPath?: string, options?: BrowseOptions): Promise<BrowseResult> {
  const resolved = dirPath ? resolvePath(dirPath) : homedir();
  assertAllowed(resolved);

  const st = await stat(resolved);
  if (!st.isDirectory()) {
    throw Object.assign(new Error("Not a directory"), { status: 400, code: "ENOTDIR" });
  }

  const names = (await readdir(resolved)).filter(
    (name) => options?.showHidden || !isHiddenName(name),
  );
  const truncated = names.length > BROWSE_MAX_ENTRIES;
  const visible = truncated ? names.slice(0, BROWSE_MAX_ENTRIES) : names;

  const statted = await mapBounded(visible, STAT_CONCURRENCY, (name) =>
    statEntry(resolve(resolved, name), name),
  );
  const entries = statted.filter((e): e is BrowseEntry => e !== null);

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentDir = dirname(resolved);
  return {
    entries,
    current: resolved,
    parent: parentDir !== resolved ? parentDir : null,
    breadcrumbs: buildBreadcrumbs(resolved),
    sep,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Label of a filesystem root: `C:` on Windows, `/` on POSIX. */
function rootLabel(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  return trimmed || "/";
}

function buildBreadcrumbs(absPath: string): { name: string; path: string }[] {
  const home = homedir();
  const parts: { name: string; path: string }[] = [];
  let current = absPath;

  while (current !== dirname(current)) {
    if (current === home) {
      parts.unshift({ name: "~", path: current });
      return parts;
    }
    parts.unshift({ name: basename(current), path: current });
    current = dirname(current);
  }

  // Reached a filesystem root (drive root on Windows, `/` on POSIX)
  if (!parts.length || parts[0]!.path !== current) {
    parts.unshift({ name: rootLabel(current), path: current });
  }
  return parts;
}

// ── List (command palette) ─────────────────────────────────────────

/** Breadth-first file listing for command palette.
 *  Lists all files at each level before descending into subdirectories,
 *  so root-level files (e.g. ~/.npmrc) are always found before the limit. */
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
      continue;
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
