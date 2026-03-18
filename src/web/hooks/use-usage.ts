import { useState, useCallback, useEffect, useRef } from "react";
import { getAuthToken, projectUrl } from "@/lib/api-client";
import type { UsageInfo } from "../../types/chat";

const POLL_INTERVAL = 30_000; // read cache every 30s

interface UseUsageReturn {
  usageInfo: UsageInfo;
  usageLoading: boolean;
  /** ISO timestamp from BE — when usage was actually fetched from Anthropic API */
  lastFetchedAt: string | null;
  refreshUsage: () => void;
}

export function useUsage(projectName: string, providerId = "claude-sdk"): UseUsageReturn {
  const [usageInfo, setUsageInfo] = useState<UsageInfo>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback((forceRefresh = false) => {
    if (!projectName) return;
    setUsageLoading(true);
    const qs = forceRefresh ? "&refresh=1" : "";
    fetch(`${projectUrl(projectName)}/chat/usage?providerId=${providerId}${qs}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    })
      .then((r) => r.json())
      .then((json: any) => {
        if (json.ok && json.data) {
          setUsageInfo((prev) => ({ ...prev, ...json.data }));
          if (json.data.lastFetchedAt) setLastFetchedAt(json.data.lastFetchedAt);
        }
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
