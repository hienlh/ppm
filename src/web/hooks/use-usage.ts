import { useState, useCallback, useEffect, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { getPrepare } from "@/lib/new-chat-prepare-client";
import type { UsageInfo } from "../../types/chat";

const POLL_INTERVAL = 120_000; // read cache every 2min
/** A seed under this age is trusted over a redundant fetch once prepare settles. */
const SEED_FRESH_MS = 30_000;
type UsageSnapshot = { scope: string; usage: UsageInfo; fetchedAt: string | null };
const usageCache = new Map<string, UsageSnapshot>();
const seedTimestamps = new Map<string, number>();

/** Same scope a fetch keys its cache entry under — exported so a seeder can populate
 * the exact same slot the hook's own read will look at. */
export function usageScopeKey(projectName: string, providerId: string, sessionId: string | undefined, pickedAccountId: string | undefined): string {
  return JSON.stringify([projectName, providerId, sessionId, pickedAccountId]);
}

/** A usage reading only describes the scope it was asked for when it reports the
 * account that scope previews; anything else is shown as empty rather than as some
 * other account's figures. Shared by the hook's fetch and `seedUsage`. */
function snapshotFor(scope: string, data: (UsageInfo & { lastFetchedAt?: string }) | null | undefined,
  pickedAccountId: string | undefined, fetchedAt: string | null | undefined): UsageSnapshot {
  const matchesAccount = !pickedAccountId || data?.activeAccountId === pickedAccountId;
  return { scope, usage: matchesAccount ? data ?? {} : {}, fetchedAt: matchesAccount ? fetchedAt ?? null : null };
}

/** Populates the cache from a `/chat/prepare` response, ahead of the hook's own
 * deferred fetch — see the `tabId` deferral below. Filtered by account exactly like
 * the fetch, so a seed can never put a different account's figures under this scope. */
export function seedUsage(scope: string, usage: UsageInfo, fetchedAt: string | null, pickedAccountId?: string): void {
  usageCache.set(scope, snapshotFor(scope, usage, pickedAccountId, fetchedAt));
  seedTimestamps.set(scope, Date.now());
}

interface UseUsageReturn {
  usageInfo: UsageInfo;
  usageLoading: boolean;
  /** ISO timestamp from BE — when usage was actually fetched. */
  lastFetchedAt: string | null;
  refreshUsage: () => void;
  /**
   * Re-read without forcing the provider to go back to its source.
   *
   * For the caller that has just changed WHICH account this session reports on, rather than
   * wanting fresher numbers for the same one. The new account's quota is already cached —
   * it is what the account panel was showing a moment ago — so `refresh=1` would drop every
   * account's cached value and re-read them all to display one figure that was already
   * known.
   */
  reloadUsage: () => void;
}

/**
 * `sessionId` scopes the reported account to this session's binding. Without it the header
 * shows whichever account ran last across every open session, which is wrong for all but one.
 *
 * `tabId`, when given, defers the initial fetch until that tab's `/chat/prepare` (if any is
 * in flight) settles — prepare already reads usage for the account it just picked, and a
 * fresh seed from it is used in place of a redundant fetch.
 */
export function useUsage(
  projectName: string,
  providerId = "claude",
  sessionId?: string,
  pickedAccountId?: string,
  enabled = true,
  tabId?: string,
): UseUsageReturn {
  // Sessionless tabs preview the account prepare picked for them; a live session's own
  // binding always wins once it exists, for either provider.
  const previewAccountId = !sessionId ? pickedAccountId : undefined;
  const scope = usageScopeKey(projectName, providerId, sessionId, pickedAccountId);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestRef = useRef(0);

  const doFetch = useCallback((forceRefresh = false): Promise<void> => {
    if (!enabled || !projectName) return Promise.resolve();
    const request = ++requestRef.current;
    setUsageLoading(true);
    const qs = forceRefresh ? "&refresh=1" : "";
    const sessionQs = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
    const accountQs = previewAccountId ? `&accountId=${encodeURIComponent(previewAccountId)}` : "";
    // Use the API client's timeout for provider reads that can stall.
    return api
      .get<(UsageInfo & { lastFetchedAt?: string }) | null>(
        `${projectUrl(projectName)}/chat/usage?providerId=${providerId}${sessionQs}${accountQs}${qs}`,
      )
      .then((data) => {
        if (request !== requestRef.current) return;
        // Each response is a snapshot, not a patch. Missing fields must clear
        // old account labels/limits, especially when switching providers.
        const next = snapshotFor(scope, data, pickedAccountId, data?.lastFetchedAt);
        usageCache.set(scope, next);
        setSnapshot(next);
      })
      .catch(() => {})
      .finally(() => {
        if (request === requestRef.current) setUsageLoading(false);
      });
  }, [projectName, providerId, sessionId, previewAccountId, pickedAccountId, scope, enabled]);

  // Read cache on mount + auto-read every POLL_INTERVAL
  useEffect(() => {
    setSnapshot(null);
    setUsageLoading(false);
    if (!enabled) return;
    let cancelled = false;
    let initialTimer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { if (!cancelled) initialTimer = setTimeout(() => doFetch(), 500); };
    const prepare = tabId ? getPrepare(tabId) : undefined;
    if (prepare) {
      prepare.then(
        () => {
          if (cancelled) return;
          const seededAt = seedTimestamps.get(scope);
          const seeded = usageCache.get(scope);
          if (seeded && seededAt !== undefined && Date.now() - seededAt < SEED_FRESH_MS) {
            setSnapshot(seeded);
            return;
          }
          schedule();
        },
        () => { if (!cancelled) schedule(); },
      );
    } else {
      schedule();
    }
    timerRef.current = setInterval(() => doFetch(), POLL_INTERVAL);
    return () => {
      cancelled = true;
      ++requestRef.current;
      if (initialTimer) clearTimeout(initialTimer);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [doFetch, enabled, tabId, scope]);

  /** Manual refresh — asks BE for fresh usage. */
  const refreshUsage = useCallback(() => doFetch(true), [doFetch]);
  /** Re-read the cached value, for when the session's account changed underneath it. */
  const reloadUsage = useCallback(() => doFetch(), [doFetch]);

  // Hide the previous scope synchronously, before the new effect runs.
  const current = enabled ? snapshot?.scope === scope ? snapshot : usageCache.get(scope) : null;
  return { usageInfo: current?.usage ?? {}, usageLoading, lastFetchedAt: current?.fetchedAt ?? null, refreshUsage, reloadUsage };
}
