/** Fetch + poll schedules for the settings section. */
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import type { Schedule, ScheduleRun } from "../../types/scheduler";

const POLL_MS = 10_000;

/**
 * The window event `use-global-events` re-dispatches after any write to `/api/schedules` — the
 * Assistant's tools and other devices included — so an open list catches up at once rather than
 * on its next poll.
 */
export const SCHEDULES_CHANGED_EVENT = "schedules:changed";

/** Calls `refetch` whenever the schedules change on the server. */
function useRefetchOnSchedulesChanged(refetch: () => unknown): void {
  useEffect(() => {
    const onChanged = () => { void refetch(); };
    window.addEventListener(SCHEDULES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SCHEDULES_CHANGED_EVENT, onChanged);
  }, [refetch]);
}

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

  useRefetchOnSchedulesChanged(refetch);

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

  // A run started from elsewhere ("run now" from the Assistant) shows up while the list is open.
  useRefetchOnSchedulesChanged(refetch);

  return { runs, loading, refetch };
}
