import { WatchTree } from "./file-watcher/watch-tree.ts";

const DEBOUNCE_MS = 500;
/**
 * Directory budgets. These bound the directories PPM *covers*, which is not the same as
 * the inotify watches it holds: measured on Linux, watching a directory costs one
 * descriptor for it plus one for every file inside — 4 directories holding 600 files
 * come to 604, recursive and non-recursive alike. So a directory cap bounds handles and
 * walk cost, not descriptors; what keeps PPM inside the machine-wide 524288 ceiling is
 * never registering `node_modules` in the first place.
 *
 * The per-project cap is hard. The total is best-effort: a tree keeps growing after
 * it starts, through `syncChildDir` -> `cover`, up to its own `maxDirs` — and on
 * Windows/macOS a recursive handle covers directories created later without telling
 * us either. So projects can add up past the total.
 *
 * A pnpm monorepo runs past 8000 directories on its own — the cap then silently stops
 * watching the rest of the tree, which reads as a file change that never arrives.
 * 12000 covers those with room to spare.
 */
const MAX_DIRS_PER_PROJECT = 12_000;
const MAX_DIRS_TOTAL = 30_000;
/**
 * Floor on what a project is handed. Dividing the total down to nothing is worse than
 * overshooting it: at 12000 per project the budgets ran 12000 -> 8000 -> **0**, and a
 * project watching zero directories reports no changes at all — the same "file change
 * that never arrives", total instead of partial, and indistinguishable from a broken
 * watcher. A late project now gets a small budget and the truncation warning instead.
 */
const MIN_DIRS_PER_PROJECT = 1_000;

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

  const maxDirs = Math.max(
    MIN_DIRS_PER_PROJECT,
    Math.min(MAX_DIRS_PER_PROJECT, MAX_DIRS_TOTAL - totalCoveredDirs()),
  );
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
