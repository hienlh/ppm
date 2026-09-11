/**
 * Shared provider-usage layer.
 *
 * Adding a provider means writing a {@link ProviderUsageSource} — how to list
 * its accounts and how to read one account's quota — and registering it. The
 * background sweep, fetch timeout, in-memory cache, negative caching, snapshot
 * persistence, and the synchronous read path all come with it.
 *
 * Registration lives in `register-usage-sources.ts` so this module stays free
 * of imports from any particular provider.
 */
export {
  AMBIENT_ACCOUNT_KEY,
  DEFAULT_POLL_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  USAGE_CACHE_TTL_MS,
  USAGE_FAILURE_TTL_MS,
  type ProviderUsageSource,
} from "./usage-source.ts";

export {
  registerUsageSource,
  getUsageSource,
  listUsageSources,
  getUsage,
  getOrFetchUsage,
  refreshUsage,
  invalidateUsage,
  _clearUsageSources,
} from "./usage-registry.ts";

export {
  startProviderUsagePolling,
  stopProviderUsagePolling,
  sweepUsageSource,
  _isUsagePollingActive,
} from "./usage-scheduler.ts";

export {
  snapshotToUsage,
  readStoredUsage,
  writeStoredUsage,
} from "./usage-snapshot-store.ts";

export { _clearUsageCache, invalidateCachedUsage } from "./usage-memory-cache.ts";

import { _clearUsageCache } from "./usage-memory-cache.ts";
import { _clearInflightUsage } from "./usage-registry.ts";
import { _clearInflightSweeps, stopProviderUsagePolling } from "./usage-scheduler.ts";

/**
 * Drop every piece of live state the layer holds: timers, in-flight fetches and
 * sweeps, and the memory cache. Stored snapshots are left alone — they are the
 * caller's data, not this layer's state.
 *
 * Used by tests, and by the production path that has to abandon a stuck sweep.
 */
export function resetUsageRuntimeState(): void {
  stopProviderUsagePolling();
  _clearInflightSweeps();
  _clearInflightUsage();
  _clearUsageCache();
}
