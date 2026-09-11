import { useState, useCallback, useEffect, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { UsageInfo } from "../../types/chat";

const POLL_INTERVAL = 120_000; // read cache every 2min

interface UseUsageReturn {
  usageInfo: UsageInfo;
  usageLoading: boolean;
  /** ISO timestamp from BE — when usage was actually fetched. */
  lastFetchedAt: string | null;
  refreshUsage: () => void;
}

/**
 * `sessionId` scopes the reported account to this session's binding. Without it the header
 * shows whichever account ran last across every open session, which is wrong for all but one.
 */
export function useUsage(projectName: string, providerId = "claude", sessionId?: string): UseUsageReturn {
  const scope = JSON.stringify([projectName, providerId, sessionId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; usage: UsageInfo; fetchedAt: string | null } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestRef = useRef(0);

  const doFetch = useCallback((forceRefresh = false) => {
    if (!projectName) return;
    const request = ++requestRef.current;
    setUsageLoading(true);
    const qs = forceRefresh ? "&refresh=1" : "";
    const sessionQs = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
    // Via api.get, not raw fetch: the toolbar's loading state is gated on this
    // settling, and a raw fetch has no timeout to stop it stalling forever.
    api
      .get<(UsageInfo & { lastFetchedAt?: string }) | null>(
        `${projectUrl(projectName)}/chat/usage?providerId=${providerId}${sessionQs}${qs}`,
      )
      .then((data) => {
        if (request !== requestRef.current) return;
        // Each response is a snapshot, not a patch. Missing fields must clear
        // old account labels/limits, especially when switching providers.
        setSnapshot({ scope, usage: data ?? {}, fetchedAt: data?.lastFetchedAt ?? null });
      })
      .catch(() => {})
      .finally(() => {
        if (request === requestRef.current) setUsageLoading(false);
      });
  }, [projectName, providerId, sessionId, scope]);

  // Read cache on mount + auto-read every POLL_INTERVAL
  useEffect(() => {
    setSnapshot(null);
    setUsageLoading(false);
    doFetch();
    timerRef.current = setInterval(() => doFetch(), POLL_INTERVAL);
    return () => {
      ++requestRef.current;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [doFetch]);

  /** Manual refresh — asks BE for fresh usage. */
  const refreshUsage = useCallback(() => doFetch(true), [doFetch]);

  // Hide the previous scope synchronously, before the new effect runs.
  const current = snapshot?.scope === scope ? snapshot : null;
  return { usageInfo: current?.usage ?? {}, usageLoading, lastFetchedAt: current?.fetchedAt ?? null, refreshUsage };
}
