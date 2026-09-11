import {
  ACCOUNT_STAGGER_MS,
  AMBIENT_ACCOUNT_KEY,
  DEFAULT_POLL_INTERVAL_MS,
  type ProviderUsageSource,
} from "./usage-source.ts";
import { listUsageSources, refreshUsage } from "./usage-registry.ts";

/**
 * The one background loop that keeps every provider's quota warm.
 *
 * Sweeping in the background is what makes reads instant: by the time the
 * toolbar asks, the value is already in memory. Both providers run on the same
 * cadence and through the same code, so a new provider gets this by registering
 * a source — there is no second timer to write.
 *
 * Survives `bun --hot` reloads through globalThis: module state resets on
 * reload, so a module-level timer would leak a new interval per reload while
 * the old one kept firing.
 */

const HOT_KEY = "__PPM_PROVIDER_USAGE_POLL__" as const;

interface HotState {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  inflight: Map<string, Promise<void>>;
}

const hot: HotState = ((globalThis as Record<string, unknown>)[HOT_KEY] ??= {
  timers: new Map(),
  inflight: new Map(),
}) as HotState;

/**
 * One pass over a source's accounts.
 *
 * Accounts are walked in series with a gap between them: a sweep is maintenance,
 * not something worth spending a burst of subprocesses or API calls on. Each
 * account is independent — `refreshUsage` never rejects, so a failing account
 * does not cut the sweep short for the ones after it.
 */
async function sweepSource(source: ProviderUsageSource): Promise<void> {
  const accountIds = source.listAccountIds();
  // No account store configured: the provider reads one ambient login instead.
  const targets = accountIds.length > 0 ? accountIds : [AMBIENT_ACCOUNT_KEY];

  for (let i = 0; i < targets.length; i++) {
    const accountId = targets[i]!;
    try {
      if (await source.shouldSkip?.(accountId)) continue;
    } catch {
      continue; // A source that cannot decide is treated as "skip", not "fetch".
    }
    await refreshUsage(source.providerId, accountId);
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, ACCOUNT_STAGGER_MS));
  }
}

/** Sweep one source now; concurrent callers share the in-flight pass. */
export function sweepUsageSource(source: ProviderUsageSource): Promise<void> {
  const existing = hot.inflight.get(source.providerId);
  if (existing) return existing;

  const pass = sweepSource(source)
    .catch((e) => console.error(`[usage] sweep ${source.providerId}:`, (e as Error).message))
    .finally(() => {
      // Only clear if still the current pass, so a stale finally cannot drop a newer one.
      if (hot.inflight.get(source.providerId) === pass) hot.inflight.delete(source.providerId);
    });

  hot.inflight.set(source.providerId, pass);
  return pass;
}

/**
 * Start the background loop for every registered source.
 *
 * Each source is swept once immediately — a fresh server should not show blank
 * percentages for a whole interval — and then rescheduled after each pass
 * completes rather than on a fixed interval, so a slow sweep cannot overlap the
 * next one.
 */
export function startProviderUsagePolling(): void {
  stopProviderUsagePolling();
  for (const source of listUsageSources()) {
    const interval = source.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const scheduleNext = () => {
      hot.timers.set(source.providerId, setTimeout(async () => {
        await sweepUsageSource(source);
        scheduleNext();
      }, interval));
    };
    sweepUsageSource(source).then(scheduleNext, scheduleNext);
  }
}

export function stopProviderUsagePolling(): void {
  for (const timer of hot.timers.values()) clearTimeout(timer);
  hot.timers.clear();
}

/**
 * Abandon any in-flight sweep so the next one starts fresh.
 *
 * Needed when a sweep is known to be stuck: without it the hung pass is handed
 * to every later caller, and a provider that stops answering blocks its own
 * refresh indefinitely. The guard in {@link sweepUsageSource} means the
 * abandoned pass cannot evict its replacement when it eventually settles.
 */
export function _clearInflightSweeps(): void {
  hot.inflight.clear();
}

/** Test seam: true while any source has a scheduled pass. */
export function _isUsagePollingActive(): boolean {
  return hot.timers.size > 0;
}
