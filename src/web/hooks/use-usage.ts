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
  /** Merge partial usage from WebSocket events (cost tracking) */
  mergeUsage: (partial: Partial<UsageInfo>) => void;
}

export function useUsage(projectName: string, providerId = "claude-sdk"): UseUsageReturn {
  const [usageInfo, setUsageInfo] = useState<UsageInfo>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUsage = useCallback(() => {
    if (!projectName) return;
    setUsageLoading(true);
    fetch(`${projectUrl(projectName)}/chat/usage?providerId=${providerId}`, {
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

  // Read cache on mount + auto-refresh
  useEffect(() => {
    fetchUsage();
    timerRef.current = setInterval(fetchUsage, POLL_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchUsage]);

  const mergeUsage = useCallback((partial: Partial<UsageInfo>) => {
    setUsageInfo((prev) => {
      const next = { ...prev, ...partial };
      if (partial.totalCostUsd != null) {
        next.queryCostUsd = partial.totalCostUsd;
        next.totalCostUsd = (prev.totalCostUsd ?? 0) + partial.totalCostUsd;
      }
      return next;
    });
  }, []);

  return { usageInfo, usageLoading, lastFetchedAt, refreshUsage: fetchUsage, mergeUsage };
}
