import { useState, useCallback, useEffect, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { UsageInfo } from "../../types/chat";

const POLL_INTERVAL = 120_000; // read cache every 2min

interface UseUsageReturn {
  usageInfo: UsageInfo;
  usageLoading: boolean;
  /** ISO timestamp from BE — when usage was actually fetched from Anthropic API */
  lastFetchedAt: string | null;
  refreshUsage: () => void;
}

export function useUsage(projectName: string, providerId = "claude"): UseUsageReturn {
  const [usageInfo, setUsageInfo] = useState<UsageInfo>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback((forceRefresh = false) => {
    if (!projectName) return;
    setUsageLoading(true);
    const qs = forceRefresh ? "&refresh=1" : "";
    // Via api.get, not raw fetch: the toolbar's loading state is gated on this
    // settling, and a raw fetch has no timeout to stop it stalling forever.
    api
      .get<(UsageInfo & { lastFetchedAt?: string }) | null>(
        `${projectUrl(projectName)}/chat/usage?providerId=${providerId}${qs}`,
      )
      .then((data) => {
        if (!data) return;
        setUsageInfo((prev) => ({ ...prev, ...data }));
        if (data.lastFetchedAt) setLastFetchedAt(data.lastFetchedAt);
      })
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  }, [projectName, providerId]);

  // Read cache on mount + auto-read every POLL_INTERVAL
  useEffect(() => {
    doFetch();
    timerRef.current = setInterval(() => doFetch(), POLL_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [doFetch]);

  /** Manual refresh — tells BE to fetch fresh from Anthropic API */
  const refreshUsage = useCallback(() => doFetch(true), [doFetch]);

  return { usageInfo, usageLoading, lastFetchedAt, refreshUsage };
}
