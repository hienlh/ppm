/**
 * Directories and files that are never worth watching.
 *
 * These are pruned at *registration* time, not when events arrive. On Linux a
 * recursive watch costs one inotify watch per subdirectory, so a dependency tree
 * left in the watch set burns tens of thousands of watches (`node_modules` alone
 * is ~90% of the directories in a typical repo) and can exhaust
 * `fs.inotify.max_user_watches` for the whole machine.
 */

/** Dependency trees, build output and tool caches — high directory count, no value to the UI. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".svelte-kit",
  ".terraform",
  ".turbo",
  ".venv",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "Pods",
  "target",
  "vendor",
  "venv",
]);

/** Lockfiles rewritten on every install — noisy, and nothing in the UI reacts to them. */
const IGNORED_FILES = new Set(["bun.lock", "bun.lockb"]);

export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

/**
 * True when an ignored directory appears anywhere in the path. Kept separate from
 * {@link isIgnoredPath} because an ignored *directory* inside a recursively watched
 * subtree means coverage has to be rebuilt, while an ignored *file* is merely noise.
 */
export function hasIgnoredDirSegment(relPath: string): boolean {
  const parts = relPath.split(/[/\\]/);
  // The last segment may be a file; treating it as a directory name is harmless
  // here because no ignored directory name doubles as a file we care about.
  return parts.some((part) => IGNORED_DIRS.has(part));
}

/** True when a change at this path is not worth reporting. */
export function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.split(/[/\\]/);
  if (IGNORED_FILES.has(parts[parts.length - 1] ?? "")) return true;
  return parts.some((part) => IGNORED_DIRS.has(part));
}
