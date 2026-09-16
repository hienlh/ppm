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
  /** Resolves once the first walk has attached its watchers. Never rejects. */
  ready: Promise<void>;
  /** The cap this tree was given — what it counts as while it is still walking. */
  maxDirs: number;
  /** True until the first walk lands, successfully or not. */
  walking: boolean;
}

const watchers = new Map<string, WatchEntry>();
/** Multiple callbacks supported — each is invoked on every file change event */
const changeCallbacks: ChangeCallback[] = [];

/** Register a callback for file change events (additive — does not replace previous) */
export function onFileChange(cb: ChangeCallback): void {
  changeCallbacks.push(cb);
}

/**
 * How many directories the live trees account for, for sizing the next project's budget.
 *
 * A tree that is still walking counts as the whole cap it was given rather than as what it has
 * reached so far. The walk hands the event loop back every few hundred directories, so its
 * count climbs for seconds — and a second project opened during one used to size its budget
 * against that unfinished number, which is how two projects starting together could each be
 * told there was room and overshoot `MAX_DIRS_TOTAL` between them. Over-counting is the safe
 * direction: the reservation is released the moment the walk lands and reports its real size.
 */
function totalCoveredDirs(): number {
  let total = 0;
  for (const entry of watchers.values()) {
    total += entry.walking ? entry.maxDirs : entry.tree.stats().dirs;
  }
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

/**
 * Start watching a project directory (ref-counted — safe to call multiple times).
 *
 * The returned promise resolves once the tree's watchers are attached, which is
 * no longer the moment this returns: covering yields the event loop every few
 * hundred directories, so a change made in between is not reported. Callers that
 * act on the filesystem immediately afterwards have to await it. It never
 * rejects — a failed walk is logged and leaves the project unwatched.
 *
 * What those yields cost is *events*, not coverage: a directory created while the
 * walk is running would otherwise end up in neither the snapshot nor under a live
 * watcher and stay unwatched for the session, so `WatchTree.start()` makes a
 * reconciliation pass before resolving. Both halves are why awaiting this matters.
 */
export function startWatching(projectName: string, projectPath: string): Promise<void> {
  const existing = watchers.get(projectName);
  if (existing) {
    existing.refCount++;
    return existing.ready;
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
    ready: Promise.resolve(),
    maxDirs,
    walking: true,
  };
  watchers.set(projectName, entry);

  // The entry is already in `watchers`, so a second caller arriving while the
  // walk is still running finds it and bumps the ref count rather than starting
  // a second tree. Covering is asynchronous now — it hands the event loop back
  // every few hundred directories instead of holding it for the whole walk — so
  // the count and the truncation warning can only be reported once it lands.
  entry.ready = entry.tree
    .start()
    .then(() => {
      entry.walking = false;
      // Stopped while the walk was still running: `stopWatching` closed this tree, so the
      // stats are now zeroes and the line would read "Started watching: proj (0 dirs, 0
      // handles)" for a project nothing is watching.
      if (watchers.get(projectName) !== entry) return;
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
    })
    .catch((e) => {
      entry.walking = false;
      entry.tree.close(); // release whatever attached before the failure
      // By identity: a stop-then-start of the same project while this walk was in flight put
      // a *new* entry in the map, and deleting unconditionally would drop that one — leaving
      // its handles unclosed and letting the next `startWatching` build a second tree over
      // the same directories.
      if (watchers.get(projectName) === entry) watchers.delete(projectName);
      console.warn(`[file-watcher] Failed to watch ${projectPath}: ${(e as Error).message}`);
    });
  return entry.ready;
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
