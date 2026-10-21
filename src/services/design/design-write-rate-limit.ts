import { DesignError } from "./design-error.ts";
import { designLockKey } from "./design-lock.ts";
import { createSlidingWindowLimiter } from "../sliding-window-limiter.ts";

/**
 * How often the canvas may write into one design: at most one write per 500 ms and 30 per
 * minute, counted per design across every device and tab.
 *
 * Canvas writes are proposed by a frame that runs the page's own scripts. The parent only
 * forwards a proposal after a real user gesture, but a page that posts one on the back of
 * every click the user makes would still get through, so the server caps the stream as
 * well: whatever gets past the parent is bounded, and each write is undoable. Only writes
 * that are about to happen are counted — a refused or stale request costs nothing — so the
 * check runs under the design lock, right before the file is written.
 */

export const WRITE_MIN_INTERVAL_MS = 500;
export const WRITES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
/** Designs tracked at once; far more than are edited in any one minute. */
const MAX_TRACKED_DESIGNS = 2048;

/** Test seam: the clock the limiter reads. */
export const designWriteClock = { now: (): number => Date.now() };

const limiter = createSlidingWindowLimiter(
  { windowMs: WINDOW_MS, max: WRITES_PER_MINUTE, minIntervalMs: WRITE_MIN_INTERVAL_MS },
  { maxKeys: MAX_TRACKED_DESIGNS },
);

/** Counts one write, or throws a 429 without counting it. */
export function takeDesignWrite(projectPath: string, slug: string): void {
  const refusal = limiter.take(designLockKey(projectPath, slug), designWriteClock.now());
  if (refusal?.reason === "interval") {
    throw new DesignError(429, "rate-limited", "Too many canvas edits at once; wait a moment and try again");
  }
  if (refusal) {
    throw new DesignError(429, "rate-limited", `At most ${WRITES_PER_MINUTE} canvas edits a minute; wait a moment and try again`);
  }
}

/** Forget every count; for tests. */
export function resetDesignWriteLimits(): void {
  limiter.reset();
}
