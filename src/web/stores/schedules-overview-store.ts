/**
 * Every schedule as the Schedules window lists it (`GET /api/schedules`), shared by the rail's
 * button, the drawer's tile and the window or tab, so one fetch feeds all of them. The feed runs
 * while anything that shows schedules is mounted (`useSchedulesFeed`): it reads once, re-reads on
 * every `schedules:changed` (any write, from any device or the Assistant), polls every 30 s while
 * the page is visible for runs that start and end on their own, and moves `now` on every 30 s so
 * "in 8h 10m" and the 24-hour count stay true without a fetch.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-client";
import { SCHEDULES_CHANGED_EVENT } from "@/hooks/use-schedules";
import { railSummary } from "../../shared/schedule-attention";
import type { ScheduleOverview } from "../../types/scheduler";

const POLL_MS = 30_000;

interface SchedulesOverviewState {
  list: ScheduleOverview[];
  loaded: boolean;
  /** Set when the last read failed and nothing was ever read. */
  error: string | null;
  now: number;
  refetch: () => Promise<void>;
  /** Swap one row for the server's answer to a write, without waiting for the next read. */
  put: (row: ScheduleOverview) => void;
  remove: (id: number) => void;
}

let inFlight: Promise<void> | null = null;

export const useSchedulesOverviewStore = create<SchedulesOverviewState>((set, get) => ({
  list: [],
  loaded: false,
  error: null,
  now: Date.now(),
  refetch: () => {
    // Several events in a burst (a write and its broadcast) share one read.
    if (inFlight) return inFlight;
    inFlight = api.get<ScheduleOverview[]>("/api/schedules")
      .then((list) => set({ list, loaded: true, error: null, now: Date.now() }))
      .catch((e) => { if (!get().loaded) set({ error: e instanceof Error ? e.message : "Could not read the schedules" }); })
      .finally(() => { inFlight = null; });
    return inFlight;
  },
  put: (row) => set((s) => ({ list: s.list.some((x) => x.id === row.id) ? s.list.map((x) => (x.id === row.id ? row : x)) : [...s.list, row] })),
  remove: (id) => set((s) => ({ list: s.list.filter((x) => x.id !== id) })),
}));

let users = 0;
let stop: (() => void) | null = null;

function startFeed(): () => void {
  const { refetch } = useSchedulesOverviewStore.getState();
  void refetch();
  const onChanged = () => { void refetch(); };
  const poll = setInterval(() => {
    if (document.visibilityState === "visible") void refetch();
    else useSchedulesOverviewStore.setState({ now: Date.now() });
  }, POLL_MS);
  const onVisible = () => { if (document.visibilityState === "visible") void refetch(); };
  window.addEventListener(SCHEDULES_CHANGED_EVENT, onChanged);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(poll);
    window.removeEventListener(SCHEDULES_CHANGED_EVENT, onChanged);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Keeps the shared list fresh while the calling component is mounted (`enabled` false skips it). */
export function useSchedulesFeed(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    users += 1;
    if (users === 1) stop = startFeed();
    return () => {
      users -= 1;
      if (users === 0) { stop?.(); stop = null; }
    };
  }, [enabled]);
}

/** The rail button's numbers: schedules running within 24 hours, and problems not dismissed. */
export function useSchedulesRailSummary(enabled = true): { upcoming: number; attention: number } {
  useSchedulesFeed(enabled);
  const list = useSchedulesOverviewStore((s) => s.list);
  const now = useSchedulesOverviewStore((s) => s.now);
  // Cheap: a list of tens of schedules, recomputed when it or the clock moves.
  return railSummary(list, now);
}
