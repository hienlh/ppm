import { useState, useCallback, useEffect, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { UsageInfo } from "../../types/chat";

const POLL_INTERVAL = 120_000; // read cache every 2min
type UsageSnapshot = { scope: string; usage: UsageInfo; fetchedAt: string | null };
const usageCache = new Map<string, UsageSnapshot>();

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
 */
export function useUsage(projectName: string, providerId = "claude", sessionId?: string, pickedAccountId?: string, enabled = true): UseUsageReturn {
  const previewAccountId = providerId === "codex" && !sessionId ? pickedAccountId : undefined;
  const scope = JSON.stringify([projectName, providerId, sessionId, pickedAccountId]);
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
        const matchesAccount = !pickedAccountId || data?.activeAccountId === pickedAccountId;
        const next = { scope, usage: matchesAccount ? data ?? {} : {}, fetchedAt: matchesAccount ? data?.lastFetchedAt ?? null : null };
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
    const initialTimer = setTimeout(() => doFetch(), 500);
    timerRef.current = setInterval(() => doFetch(), POLL_INTERVAL);
    return () => {
      ++requestRef.current;
      clearTimeout(initialTimer);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [doFetch, enabled]);

  /** Manual refresh — asks BE for fresh usage. */
  const refreshUsage = useCallback(() => doFetch(true), [doFetch]);
  /** Re-read the cached value, for when the session's account changed underneath it. */
  const reloadUsage = useCallback(() => doFetch(), [doFetch]);

  // Hide the previous scope synchronously, before the new effect runs.
  const current = enabled ? snapshot?.scope === scope ? snapshot : usageCache.get(scope) : null;
  return { usageInfo: current?.usage ?? {}, usageLoading, lastFetchedAt: current?.fetchedAt ?? null, refreshUsage, reloadUsage };
}
