import type { UsageInfo } from "../../types/chat.ts";
import {
  AMBIENT_ACCOUNT_KEY,
  FETCH_TIMEOUT_MS,
  type ProviderUsageSource,
} from "./usage-source.ts";
import {
  getCachedUsageEntry,
  isRecentlyFailed,
  setCachedFailure,
  setCachedUsage,
  invalidateCachedUsage,
} from "./usage-memory-cache.ts";
import { readStoredUsage, writeStoredUsage } from "./usage-snapshot-store.ts";

/**
 * Registry of provider usage sources, and the read/refresh path over them.
 *
 * The rule the whole layer exists to enforce: **reads never wait on a provider.**
 * `getUsage` is synchronous and answers from memory, falling back to the stored
 * snapshot. Anything that talks to a provider happens on the background sweep or
 * behind an explicit refresh, both of which are bounded by a timeout.
 */

const sources = new Map<string, ProviderUsageSource>();

export function registerUsageSource(source: ProviderUsageSource): void {
  sources.set(source.providerId, source);
}

export function getUsageSource(providerId: string): ProviderUsageSource | undefined {
  return sources.get(providerId);
}

export function listUsageSources(): ProviderUsageSource[] {
  return [...sources.values()];
}

/** Test seam: drop every registered source. */
export function _clearUsageSources(): void {
  sources.clear();
}

/**
 * Latest known usage for one account, without ever touching the provider.
 *
 * Memory first, then the stored snapshot — which is what makes a percentage
 * appear immediately after a restart, before the first sweep lands. Returns an
 * empty object when nothing has ever been recorded; the caller cannot tell that
 * apart from "no limits reported", and does not need to.
 */
export function getUsage(providerId: string, accountId = AMBIENT_ACCOUNT_KEY): UsageInfo {
  const cached = getCachedUsageEntry(providerId, accountId);
  if (cached) return cached;
  const stored = readStoredUsage(providerId, accountId);
  if (stored) {
    // Promote into memory so the next read skips the query, but keep the
    // provider's own freshness clock: this value is as old as it ever was.
    setCachedUsage(providerId, accountId, stored);
    return stored;
  }
  return {};
}

/** Reject if `promise` has not settled within `ms`, naming what timed out. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Concurrent refreshes of the same account share one in-flight fetch.
 *
 * Each attempt carries a token so its cleanup can tell "I am still the current
 * attempt" from "I was abandoned and something newer took my place".
 */
const inflight = new Map<string, { token: object; promise: Promise<UsageInfo> }>();

/**
 * Fetch one account live, then cache and store it.
 *
 * Failures are swallowed into the last known value rather than propagated: the
 * callers are a background sweep and a toolbar refresh, and neither has anything
 * useful to do with the error beyond showing what it already had. The failure is
 * still remembered so it does not turn into a retry per request.
 */
export async function refreshUsage(
  providerId: string,
  accountId = AMBIENT_ACCOUNT_KEY,
): Promise<UsageInfo> {
  const source = sources.get(providerId);
  if (!source) return {};

  const key = `${providerId}\0${accountId}`;
  const existing = inflight.get(key);
  if (existing) return existing.promise;

  // Identity for this attempt. Comparing tokens rather than the promise avoids
  // the closure having to reference the very promise it is producing.
  const token = {};
  const run = (async () => {
    try {
      const usage = await withTimeout(
        source.fetch(accountId),
        source.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
        `${providerId} usage fetch`,
      );
      setCachedUsage(providerId, accountId, usage);
      writeStoredUsage(providerId, accountId, usage);
      return usage;
    } catch (e) {
      setCachedFailure(providerId, accountId);
      console.error(`[usage] ${providerId}/${accountId || "ambient"}:`, (e as Error).message);
      return readStoredUsage(providerId, accountId) ?? {};
    } finally {
      // Only clear if this is still the current attempt. An abandoned fetch
      // that finishes late must not evict the entry a newer one just installed,
      // or that newer caller would be silently un-deduped.
      if (inflight.get(key)?.token === token) inflight.delete(key);
    }
  })();

  inflight.set(key, { token, promise: run });
  return run;
}

/** Test seam: forget every in-flight fetch so the next call starts a fresh one. */
export function _clearInflightUsage(): void {
  inflight.clear();
}

/**
 * Read, fetching only if nothing usable is known yet.
 *
 * Used by the request path so a cold start still produces a number, while a
 * remembered failure short-circuits to the stored value instead of re-attempting
 * a fetch on every request.
 */
export async function getOrFetchUsage(
  providerId: string,
  accountId = AMBIENT_ACCOUNT_KEY,
): Promise<UsageInfo> {
  const known = getUsage(providerId, accountId);
  if (Object.keys(known).length > 0) return known;
  if (isRecentlyFailed(providerId, accountId)) return known;
  return refreshUsage(providerId, accountId);
}

/** Force the next read of this provider (or one account) to go back to the source. */
export function invalidateUsage(providerId: string, accountId?: string): void {
  invalidateCachedUsage(providerId, accountId);
}
