/**
 * Bounded concurrency gate for thumbnail fetches, shared by every `ThumbnailImage` instance
 * on screen — a folder of a thousand photos must still cap at `MAX_CONCURRENT` in-flight
 * `/api/fs/raw` requests rather than firing one per tile.
 *
 * `acquireSlot()` resolves once a slot is free; the returned release function is idempotent
 * (safe to call more than once for the same acquisition) — a caller may release both from a
 * `finally` block and from an effect cleanup that fires for the same completed fetch, and a
 * second release must be a no-op rather than decrementing `active` twice.
 */

export const MAX_CONCURRENT = 24;

let active = 0;
const queue: (() => void)[] = [];

export function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    let released = false;
    const run = () => {
      active++;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

/** Current in-flight count — exposed for tests only. */
export function activeCount(): number {
  return active;
}

/** Resets module state between tests. */
export function _resetSemaphore(): void {
  active = 0;
  queue.length = 0;
}
