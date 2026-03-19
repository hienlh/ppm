import {
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename, dirname, normalize } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified: string;
}

export interface BrowseResult {
  entries: BrowseEntry[];
  current: string;
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
}

export interface BrowseOptions {
  showHidden?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const LIST_MAX_FILES = 200;
const LIST_MAX_DEPTH = 4;
const READ_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

/** Roots allowed for system-level browsing (outside project scope). */
const ALLOWED_ROOTS_POSIX = ["/Volumes", "/mnt", "/media", "/tmp", "/home"];

// ── Shared helpers ─────────────────────────────────────────────────

/** Resolve a path, expanding leading `~` to home directory. */
export function resolvePath(input: string): string {
  const home = homedir();
  return input.startsWith("~")
    ? resolve(home, input.slice(2))
    : resolve(input);
}

/** Check if an absolute path is within the allowed whitelist. */
export function isAllowedPath(resolved: string): boolean {
  const home = homedir();
  if (resolved === home || resolved.startsWith(home + "/")) return true;

  if (process.platform === "win32") {
    return /^[A-Z]:\\/i.test(resolved);
  }

  return ALLOWED_ROOTS_POSIX.some(
    (r) => resolved === r || resolved.startsWith(r + "/"),
  );
}

// ── Browse (new) ───────────────────────────────────────────────────

/** List entries of a single directory (1-level, structured). */
export function browse(
  dirPath?: string,
  options?: BrowseOptions,
): BrowseResult {
  const resolved = dirPath ? resolvePath(dirPath) : homedir();

  if (!isAllowedPath(resolved)) {
    throw Object.assign(new Error("Access denied"), { status: 403 });
  }
  if (!existsSync(resolved)) {
    throw Object.assign(new Error("Directory not found"), { status: 404 });
  }
  if (!statSync(resolved).isDirectory()) {
    throw Object.assign(new Error("Not a directory"), { status: 400 });
  }

  const raw = readdirSync(resolved, { withFileTypes: true });
  const entries: BrowseEntry[] = [];

  for (const entry of raw) {
    if (!options?.showHidden && entry.name.startsWith(".")) continue;
    if (entry.name.startsWith(".env")) continue; // always hide .env*

    const fullPath = resolve(resolved, entry.name);
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
      const st = statSync(fullPath);
      entries.push({
        name: entry.name,
        path: fullPath,
        type: st.isDirectory() ? "directory" : "file",
        size: st.isFile() ? st.size : undefined,
        modified: st.mtime.toISOString(),
      });
    } catch {
      /* permission denied — skip */
    }
  }

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
  };
}

function buildBreadcrumbs(
  absPath: string,
): { name: string; path: string }[] {
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

  // Reached filesystem root
  if (!parts.length || parts[0]!.path !== current) {
    parts.unshift({ name: basename(current) || "/", path: current });
  }
  return parts;
}

// ── List (moved from index.ts inline) ──────────────────────────────

/** Recursive file listing for command palette. */
export function list(dir: string): string[] {
  const resolved = resolvePath(dir);
  if (!isAllowedPath(resolved)) {
    throw Object.assign(new Error("Access denied"), { status: 403 });
  }

  const files: string[] = [];

  function walk(dirPath: string, depth: number) {
    if (depth > LIST_MAX_DEPTH || files.length >= LIST_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const full = resolve(dirPath, entry.name);
      if (entry.isFile()) {
        files.push(full);
        if (files.length >= LIST_MAX_FILES) return;
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }

  walk(resolved, 0);
  return files;
}

// ── Read (moved from index.ts inline) ──────────────────────────────

/** Read a file outside project scope. */
export function readSystemFile(
  filePath: string,
): { content: string; path: string } {
  const resolved = resolvePath(filePath);
  if (!isAllowedPath(resolved)) {
    throw Object.assign(new Error("Access denied"), { status: 403 });
  }
  if (!existsSync(resolved)) {
    throw Object.assign(new Error("File not found"), { status: 404 });
  }

  const st = statSync(resolved);
  if (!st.isFile()) {
    throw Object.assign(new Error("Not a file"), { status: 400 });
  }
  if (st.size > READ_MAX_SIZE) {
    throw Object.assign(new Error("File too large (>5MB)"), { status: 400 });
  }

  const content = readFileSync(resolved, "utf-8");
  return { content, path: resolved };
}

// ── Write (moved from index.ts inline) ─────────────────────────────

/** Write a file outside project scope. */
export function writeSystemFile(filePath: string, content: string): void {
  const resolved = resolvePath(filePath);
  if (!isAllowedPath(resolved)) {
    throw Object.assign(new Error("Access denied"), { status: 403 });
  }
  writeFileSync(resolved, content, "utf-8");
}
