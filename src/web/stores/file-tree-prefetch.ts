/**
 * Idle prefetch queue for explorer folder children.
 * After a folder loads, children of its non-gitignored subfolders are fetched
 * during browser idle time so the next click renders instantly (hides remote RTT).
 * One level ahead only — prefetched loads never enqueue further prefetches.
 */
import type { FileNode } from "./file-store";

const MAX_FOLDERS_PER_BATCH = 20;
const CONCURRENCY = 3;

type LoadFn = (path: string) => Promise<void>;

let queue: string[] = [];
let active = 0;
let generation = 0;
let loadFn: LoadFn | null = null;

const idle: (cb: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(() => cb(), { timeout: 1000 })
    : (cb) => setTimeout(cb, 200);

function pump(gen: number): void {
  if (gen !== generation) return;
  while (active < CONCURRENCY && queue.length > 0) {
    const path = queue.shift()!;
    active++;
    loadFn!(path).finally(() => {
      active--;
      if (gen === generation) idle(() => pump(gen));
    });
  }
}

/** Queue children of the given nodes for idle prefetch (skips ignored dirs) */
export function schedulePrefetch(
  children: FileNode[],
  isAlreadyLoadedOrInflight: (path: string) => boolean,
  load: LoadFn,
): void {
  loadFn = load;
  const dirs = children
    .filter((c) => c.type === "directory" && !c.ignored && !isAlreadyLoadedOrInflight(c.path))
    .slice(0, MAX_FOLDERS_PER_BATCH)
    .map((c) => c.path);
  if (dirs.length === 0) return;
  queue.push(...dirs.filter((p) => !queue.includes(p)));
  const gen = generation;
  idle(() => pump(gen));
}

/** Drop all pending prefetches (project switch / store reset) */
export function cancelPrefetch(): void {
  generation++;
  queue = [];
}
