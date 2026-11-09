import { createSlidingWindowLimiter, type LimitRefusal, type WindowRule } from "../../sliding-window-limiter.ts";

/**
 * Request budgets of the public share routes, each counted on its own so one kind of
 * traffic cannot starve another: loading a design's files does not use up comment polls.
 *
 * Per client key (see `design-share-client-key.ts`):
 * - `assets`: the shared design's files, 1200 a minute — a 100-file design loaded by ten
 *   reviewers who all share the `local` key still fits;
 * - `api`: the page, link info and comment reads, 120 a minute;
 * - writes: one per 500 ms and 20 a minute, per reviewer key on that address;
 * Per link, whoever writes: 30 writes a minute, so forging client keys gains nothing.
 *
 * Each map keeps at most {@link MAX_CLIENT_KEYS} keys, dropping the least recently used.
 */

const MINUTE = 60_000;
export const MAX_CLIENT_KEYS = 2048;

export const SHARE_BUDGETS = {
  assets: { windowMs: MINUTE, max: 1200, granularityMs: 1000 },
  api: { windowMs: MINUTE, max: 120, granularityMs: 1000 },
  clientWrites: { windowMs: MINUTE, max: 20, minIntervalMs: 500 },
  linkWrites: { windowMs: MINUTE, max: 30 },
} as const satisfies Record<string, WindowRule>;

/** Test seam: the clock every share budget reads. */
export const shareRateClock = { now: (): number => Date.now() };

const limiters = {
  assets: createSlidingWindowLimiter(SHARE_BUDGETS.assets, { maxKeys: MAX_CLIENT_KEYS }),
  api: createSlidingWindowLimiter(SHARE_BUDGETS.api, { maxKeys: MAX_CLIENT_KEYS }),
  clientWrites: createSlidingWindowLimiter(SHARE_BUDGETS.clientWrites, { maxKeys: MAX_CLIENT_KEYS }),
  linkWrites: createSlidingWindowLimiter(SHARE_BUDGETS.linkWrites, { maxKeys: MAX_CLIENT_KEYS }),
};

export type ShareReadBudget = "assets" | "api";

/** Counts one read; answers how long to wait (ms) when over budget, else 0. */
export function takeShareRead(budget: ShareReadBudget, clientKey: string): number {
  return limiters[budget].take(clientKey, shareRateClock.now())?.retryMs ?? 0;
}

/** Whether this client may write now, counting nothing (checked before the code is looked up). */
export function checkShareClientWrite(clientKey: string): number {
  return limiters.clientWrites.check(clientKey, shareRateClock.now())?.retryMs ?? 0;
}

/** Counts one write against both the client and the link, or neither when either is over. */
export function takeShareWrite(clientKey: string, linkId: string): number {
  const now = shareRateClock.now();
  const refusals = [limiters.clientWrites.check(clientKey, now), limiters.linkWrites.check(linkId, now)]
    .filter((r): r is LimitRefusal => r !== null);
  if (refusals.length) return Math.max(...refusals.map((r) => r.retryMs));
  limiters.clientWrites.record(clientKey, now);
  limiters.linkWrites.record(linkId, now);
  return 0;
}

/** Keys currently tracked per budget (tests). */
export function shareLimiterSizes(): Record<keyof typeof limiters, number> {
  return {
    assets: limiters.assets.size, api: limiters.api.size,
    clientWrites: limiters.clientWrites.size, linkWrites: limiters.linkWrites.size,
  };
}

/** Forget every count (tests). */
export function resetShareRateLimits(): void {
  for (const limiter of Object.values(limiters)) limiter.reset();
}
