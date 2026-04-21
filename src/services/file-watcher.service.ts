import { watch, type FSWatcher } from "node:fs";

const IGNORE = new Set([
  ".git", "node_modules", "dist", "build", ".next",
  ".turbo", "coverage", "__pycache__", "bun.lock",
]);
const DEBOUNCE_MS = 500;

type ChangeCallback = (projectName: string, path: string) => void;

interface WatchEntry {
  watcher: FSWatcher;
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

function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(/[/\\]/);
  return parts.some((p) => IGNORE.has(p));
}

/** Start watching a project directory (ref-counted — safe to call multiple times) */
export function startWatching(projectName: string, projectPath: string): void {
  const existing = watchers.get(projectName);
  if (existing) {
    existing.refCount++;
    return;
  }

  try {
    const watcher = watch(projectPath, { recursive: true }, (_event, filename) => {
      if (!filename || shouldIgnore(filename)) return;
      const entry = watchers.get(projectName);
      if (!entry) return;

      entry.pending.add(filename);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        const paths = [...entry.pending];
        entry.pending.clear();
        for (const p of paths) {
          const relPath = p.replaceAll("\\", "/");
          for (const cb of changeCallbacks) cb(projectName, relPath);
        }
      }, DEBOUNCE_MS);
    });

    watchers.set(projectName, { watcher, refCount: 1, pending: new Set() });
    console.log(`[file-watcher] Started watching: ${projectName}`);
  } catch (e) {
    console.warn(`[file-watcher] Failed to watch ${projectPath}: ${(e as Error).message}`);
  }
}

/** Decrement ref count — stops watcher when no clients remain */
export function stopWatching(projectName: string): void {
  const entry = watchers.get(projectName);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    watchers.delete(projectName);
    console.log(`[file-watcher] Stopped watching: ${projectName}`);
  }
}
