/**
 * A keyed sliding-window rate limiter with a bounded number of keys.
 *
 * Each key keeps the times of its recent hits (at most `max` of them), so a refusal says
 * exactly how long until the oldest one ages out. `granularityMs` folds hits that land
 * within that span of each other into one entry, which keeps a large budget (hundreds a
 * minute) at a few dozen entries per key; 0 keeps every hit exact.
 *
 * Keys are kept in least-recently-used order and the oldest is dropped past `maxKeys`, so a
 * caller that can mint keys at will (a forged client address) cannot grow the map without
 * bound. Nothing sweeps the whole map: each key is pruned when it is touched.
 */

export interface WindowRule {
  windowMs: number;
  /** Hits allowed per window. */
  max: number;
  /** Least time between two hits of one key; 0 or absent for none. */
  minIntervalMs?: number;
  /** Hits this close to the previous entry share it; 0 or absent keeps each hit exact. */
  granularityMs?: number;
}

export type LimitReason = "interval" | "window";

export interface LimitRefusal {
  reason: LimitReason;
  /** How long until the same request would be allowed. */
  retryMs: number;
}

interface Slot { t: number; n: number }
interface KeyState { slots: Slot[]; count: number; last: number }

export interface SlidingWindowLimiter {
  /** Why `key` may not hit now, or null when it may. Counts nothing. */
  check(key: string, now: number): LimitRefusal | null;
  /** Count one hit for `key`, unconditionally. */
  record(key: string, now: number): void;
  /** {@link check}, then {@link record} when allowed. */
  take(key: string, now: number): LimitRefusal | null;
  reset(): void;
  readonly size: number;
}

export function createSlidingWindowLimiter(rule: WindowRule, opts: { maxKeys: number }): SlidingWindowLimiter {
  const minInterval = rule.minIntervalMs ?? 0;
  const granularity = rule.granularityMs ?? 0;
  const keys = new Map<string, KeyState>();

  /** The key's live state with aged-out hits removed, or undefined when nothing is left. */
  function live(key: string, now: number): KeyState | undefined {
    const state = keys.get(key);
    if (!state) return undefined;
    let drop = 0;
    while (drop < state.slots.length && now - state.slots[drop]!.t >= rule.windowMs) {
      state.count -= state.slots[drop]!.n;
      drop++;
    }
    if (drop) state.slots.splice(0, drop);
    if (state.slots.length === 0 && now - state.last >= minInterval) {
      keys.delete(key);
      return undefined;
    }
    return state;
  }

  function check(key: string, now: number): LimitRefusal | null {
    const state = live(key, now);
    if (!state) return null;
    if (minInterval && now - state.last < minInterval) return { reason: "interval", retryMs: minInterval - (now - state.last) };
    if (state.count >= rule.max) return { reason: "window", retryMs: rule.windowMs - (now - state.slots[0]!.t) };
    return null;
  }

  function record(key: string, now: number): void {
    const state = live(key, now) ?? { slots: [], count: 0, last: now };
    const tail = state.slots[state.slots.length - 1];
    if (tail && granularity && now - tail.t < granularity) tail.n++;
    else state.slots.push({ t: now, n: 1 });
    state.count++;
    state.last = now;
    // Re-inserting moves the key to the most recent end.
    keys.delete(key);
    keys.set(key, state);
    while (keys.size > opts.maxKeys) {
      const oldest = keys.keys().next();
      if (oldest.done) break;
      keys.delete(oldest.value);
    }
  }

  return {
    check,
    record,
    take(key, now) {
      const refusal = check(key, now);
      if (!refusal) record(key, now);
      return refusal;
    },
    reset: () => keys.clear(),
    get size() {
      return keys.size;
    },
  };
}
