/**
 * The session schedules of one chat, for its footer chip. Asked for once per chat and again on
 * every `schedules:changed` (any write to `/api/schedules`, and each delivery or pause the server
 * makes), so the chip follows a schedule the AI adds mid-turn without polling.
 *
 * The server matches the chat under every id it had, so the id the tab holds is enough.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { SCHEDULES_CHANGED_EVENT } from "./use-schedules";
import type { ScheduleView } from "../../types/scheduler";

export function useSessionSchedules(sessionId: string | null | undefined) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  // Answers for an earlier chat (the tab moved on) are dropped rather than shown here.
  const latest = useRef(sessionId);
  latest.current = sessionId;

  const refetch = useCallback(async () => {
    if (!sessionId) { setSchedules([]); return; }
    try {
      const rows = await api.get<ScheduleView[]>(`/api/schedules?session=${encodeURIComponent(sessionId)}`);
      if (latest.current === sessionId) setSchedules(Array.isArray(rows) ? rows : []);
    } catch {
      // Keep what is shown: the next change event asks again.
    }
  }, [sessionId]);

  useEffect(() => {
    setSchedules([]);
    void refetch();
    const onChanged = () => { void refetch(); };
    window.addEventListener(SCHEDULES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SCHEDULES_CHANGED_EVENT, onChanged);
  }, [refetch]);

  return { schedules, refetch };
}
