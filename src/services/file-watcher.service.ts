import { WatchTree } from "./file-watcher/watch-tree.ts";

const DEBOUNCE_MS = 500;
/**
 * Directory budgets. One covered directory costs one inotify watch on Linux, and
 * the machine-wide default ceiling is 524288 shared with every other process, so
 * PPM stays well inside it even with several projects watched at once.
 *
 * The per-project cap is hard. The total is best-effort: a native recursive watch
 * picks up directories created later without telling us, so exact accounting is not
 * possible — the worst case is a few projects at their own cap, still ~4% of the
 * kernel ceiling.
 */
const MAX_DIRS_PER_PROJECT = 8_000;
const MAX_DIRS_TOTAL = 20_000;

type ChangeCallback = (projectName: string, path: string) => void;

interface WatchEntry {
  tree: WatchTree;
  refCount: number;
  timer?: ReturnType<typeof setTimeout>;
  pending: Set<string>;
}

const watchers = new Map<string, WatchEntry>();
/** Multiple callbacks supported — each is invoked on every file change event */
const changeCallbacks: ChangeCallback[] = [];

/** Register a callback for file change events (additive — does not replace previous) */
export function onFileChange(cb: ChangeCallback): void {
  changeCallbacks.push(cb);
}

function totalCoveredDirs(): number {
  let total = 0;
  for (const entry of watchers.values()) total += entry.tree.stats().dirs;
  return total;
}

/**
 * Emit on a fixed window rather than restarting the timer per event: a project
 * under continuous churn (a build, a large checkout) would otherwise keep pushing
 * the deadline back and never notify the UI at all.
 */
function queue(entry: WatchEntry, projectName: string, relPath: string): void {
  entry.pending.add(relPath);
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    const paths = [...entry.pending];
    entry.pending.clear();
    for (const path of paths) {
      for (const cb of changeCallbacks) cb(projectName, path);
    }
  }, DEBOUNCE_MS);
}

/** Start watching a project directory (ref-counted — safe to call multiple times) */
export function startWatching(projectName: string, projectPath: string): void {
  const existing = watchers.get(projectName);
  if (existing) {
    existing.refCount++;
    return;
  }

  const maxDirs = Math.max(0, Math.min(MAX_DIRS_PER_PROJECT, MAX_DIRS_TOTAL - totalCoveredDirs()));
  const entry: WatchEntry = {
    tree: new WatchTree({
      root: projectPath,
      maxDirs,
      onChange: (relPath) => {
        // Look the entry up again: it may have been stopped while an event was queued.
        const current = watchers.get(projectName);
        if (current) queue(current, projectName, relPath);
      },
    }),
    refCount: 1,
    pending: new Set(),
  };
  watchers.set(projectName, entry);

  try {
    entry.tree.start();
  } catch (e) {
    entry.tree.close(); // release whatever attached before the failure
    watchers.delete(projectName);
    console.warn(`[file-watcher] Failed to watch ${projectPath}: ${(e as Error).message}`);
    return;
  }

  const { dirs, watchers: handles, truncated } = entry.tree.stats();
  console.log(
    `[file-watcher] Started watching: ${projectName} (${dirs} dirs, ${handles} handles${truncated ? ", capped" : ""})`,
  );
  if (truncated) {
    console.warn(
      `[file-watcher] ${projectName} exceeded the ${maxDirs}-directory budget — ` +
      `parts of the tree are not watched. Add build/cache directories to the ignore list.`,
    );
  }
}

/** Decrement ref count — stops watcher when no clients remain */
export function stopWatching(projectName: string): void {
  const entry = watchers.get(projectName);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.tree.close();
    watchers.delete(projectName);
    console.log(`[file-watcher] Stopped watching: ${projectName}`);
  }
}
