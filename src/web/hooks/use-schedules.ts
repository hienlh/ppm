/** Fetch + poll schedules for the settings section. */
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import type { Schedule, ScheduleRun } from "../../types/scheduler";

const POLL_MS = 10_000;

export function useSchedules() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      setSchedules(await api.get<Schedule[]>("/api/schedules"));
    } catch {
      // Keep stale list on transient errors; next poll retries
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  return { schedules, loading, refetch };
}

export function useScheduleRuns(scheduleId: number | null) {
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (scheduleId == null) return;
    setLoading(true);
    try {
      setRuns(await api.get<ScheduleRun[]>(`/api/schedules/${scheduleId}/runs?limit=20`));
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [scheduleId]);

  useEffect(() => { refetch(); }, [refetch]);

  return { runs, loading, refetch };
}
