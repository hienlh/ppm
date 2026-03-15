import { useState, useCallback, useEffect, useRef } from "react";
import { getAuthToken, projectUrl } from "@/lib/api-client";
import type { UsageInfo } from "../../types/chat";

const POLL_INTERVAL = 60_000; // 60s auto-refresh

interface UseUsageReturn {
  usageInfo: UsageInfo;
  usageLoading: boolean;
  lastUpdatedAt: number | null;
  refreshUsage: () => void;
  /** Merge partial usage from WebSocket events (cost tracking) */
  mergeUsage: (partial: Partial<UsageInfo>) => void;
}

export function useUsage(projectName: string, providerId = "claude-sdk"): UseUsageReturn {
  const [usageInfo, setUsageInfo] = useState<UsageInfo>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUsage = useCallback((bustCache = false) => {
    if (!projectName) return;
    setUsageLoading(true);
    const qs = bustCache ? `&_t=${Date.now()}` : "";
    fetch(`${projectUrl(projectName)}/chat/usage?providerId=${providerId}${qs}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    })
      .then((r) => r.json())
      .then((json: any) => {
        if (json.ok && json.data) {
          setUsageInfo((prev) => ({ ...prev, ...json.data }));
          setLastUpdatedAt(Date.now());
        }
      })
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  }, [projectName, providerId]);

  // Initial fetch + auto-refresh interval
  useEffect(() => {
    fetchUsage();
    timerRef.current = setInterval(() => fetchUsage(true), POLL_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchUsage]);

  const refreshUsage = useCallback(() => {
    fetchUsage(true);
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

  return { usageInfo, usageLoading, lastUpdatedAt, refreshUsage, mergeUsage };
}
