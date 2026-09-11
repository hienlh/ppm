import type { UsageInfo } from "../../types/chat.ts";
import { USAGE_CACHE_TTL_MS, USAGE_FAILURE_TTL_MS } from "./usage-source.ts";

/**
 * In-memory layer in front of the snapshot store, keyed by provider + account.
 *
 * Two things live here that the store cannot express. One is freshness: the
 * store knows the last value but not whether it is worth re-reading yet. The
 * other is failure — a rejected fetch has nothing to persist, yet must still be
 * remembered, or every request that misses re-attempts it. For codex that meant
 * spawning an app-server per request, and a spawn that hangs is never reaped.
 */

interface Entry {
  /** Absent for a remembered failure. */
  usage?: UsageInfo;
  expiry: number;
  failed: boolean;
}

const cache = new Map<string, Entry>();

function key(providerId: string, accountId: string): string {
  return `${providerId}\0${accountId}`;
}

/** Cached value if still fresh; `undefined` when absent, stale, or a failure. */
export function getCachedUsageEntry(providerId: string, accountId: string): UsageInfo | undefined {
  const hit = cache.get(key(providerId, accountId));
  if (!hit || Date.now() >= hit.expiry || hit.failed) return undefined;
  return hit.usage;
}

/**
 * True while a recent failure is still remembered — the caller should neither
 * re-fetch nor treat the absence as "never tried".
 */
export function isRecentlyFailed(providerId: string, accountId: string): boolean {
  const hit = cache.get(key(providerId, accountId));
  return !!hit && hit.failed && Date.now() < hit.expiry;
}

export function setCachedUsage(providerId: string, accountId: string, usage: UsageInfo): void {
  cache.set(key(providerId, accountId), {
    usage,
    expiry: Date.now() + USAGE_CACHE_TTL_MS,
    failed: false,
  });
}

export function setCachedFailure(providerId: string, accountId: string): void {
  cache.set(key(providerId, accountId), {
    expiry: Date.now() + USAGE_FAILURE_TTL_MS,
    failed: true,
  });
}

/** Drop one entry so the next read re-fetches — used by an explicit refresh. */
export function invalidateCachedUsage(providerId: string, accountId?: string): void {
  if (accountId !== undefined) {
    cache.delete(key(providerId, accountId));
    return;
  }
  const prefix = `${providerId}\0`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** Test seam: forget everything. */
export function _clearUsageCache(): void {
  cache.clear();
}
