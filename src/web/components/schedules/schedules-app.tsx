/**
 * The Schedules window: every schedule of every project, filtered by project and chip, grouped
 * into Needs attention, Next 24 hours, Later and Off. In a window it is a list with the selected
 * schedule's details beside it once the window is wide enough (`@container`, 900px), and expanded
 * under its row when it is not. On a phone (the `schedules` tab) it is a list of cards: a tap
 * opens the details in a sheet, a long press the actions.
 */
import { useEffect, useMemo, useState } from "react";
import { CalendarClock } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { ScheduleForm } from "@/components/settings/schedules/schedule-form";
import { cn } from "@/lib/utils";
import { useSchedulesFeed, useSchedulesOverviewStore } from "@/stores/schedules-overview-store";
import {
  chipCounts, DEFAULT_FILTER, filterSchedules, groupSchedules, isBypass, projectsOf, type SchedulesFilter,
} from "@/lib/schedules/schedules-view";
import { railSummary } from "../../../shared/schedule-attention";
import type { ScheduleOverview, ScheduleView } from "../../../types/scheduler";
import { SCHEDULES_SELECT_EVENT, takeSchedulesSelection } from "./open-schedules";
import { ScheduleOverviewCard } from "./schedule-overview-card";
import { ScheduleOverviewDetail } from "./schedule-overview-detail";
import { ROW_GRID, ScheduleOverviewRow } from "./schedule-overview-row";
import { SchedulePromptSheet } from "./schedule-prompt-sheet";
import { SchedulesToolbar } from "./schedules-toolbar";
import { useScheduleActions } from "./use-schedule-actions";

const FILTER_KEY = "ppm:schedules-filter";

function savedFilter(): SchedulesFilter {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as Partial<SchedulesFilter> | null;
    return { ...DEFAULT_FILTER, project: typeof raw?.project === "string" ? raw.project : null };
  } catch {
    return DEFAULT_FILTER;
  }
}

export function SchedulesApp({ mode }: { mode: "window" | "phone" }) {
  useSchedulesFeed();
  const list = useSchedulesOverviewStore((s) => s.list);
  const loaded = useSchedulesOverviewStore((s) => s.loaded);
  const error = useSchedulesOverviewStore((s) => s.error);
  const now = useSchedulesOverviewStore((s) => s.now);
  const actions = useScheduleActions();
  const [filter, setFilter] = useState<SchedulesFilter>(savedFilter);
  const [selected, setSelected] = useState<number | null>(() => takeSchedulesSelection());
  const [promptOf, setPromptOf] = useState<number | null>(null);
  const [editing, setEditing] = useState<ScheduleView | null | undefined>(undefined);
  const phone = mode === "phone";

  useEffect(() => {
    const onSelect = () => { const id = takeSchedulesSelection(); if (id !== null) { setSelected(id); setFilter({ ...DEFAULT_FILTER }); } };
    window.addEventListener(SCHEDULES_SELECT_EVENT, onSelect);
    return () => window.removeEventListener(SCHEDULES_SELECT_EVENT, onSelect);
  }, []);

  const changeFilter = (next: SchedulesFilter) => {
    setFilter(next);
    // Only the project is remembered (per device): chips and search are for the moment.
    try { localStorage.setItem(FILTER_KEY, JSON.stringify({ project: next.project })); } catch { /* storage blocked */ }
  };

  const projects = useMemo(() => projectsOf(list), [list]);
  const shown = useMemo(() => filterSchedules(list, filter, now), [list, filter, now]);
  const groups = useMemo(() => groupSchedules(shown, now), [shown, now]);
  const counts = useMemo(() => chipCounts(list, filter.project, now), [list, filter.project, now]);
  const summary = useMemo(() => railSummary(shown, now), [shown, now]);
  const failed = shown.filter((s) => s.enabled && s.last_run?.status === "error").length;
  const bypass = shown.filter((s) => s.enabled && isBypass(s)).length;
  const current = list.find((s) => s.id === selected) ?? null;
  const promptSchedule = list.find((s) => s.id === promptOf) ?? null;
  const select = (s: ScheduleOverview) => setSelected(selected === s.id && !phone ? null : s.id);
  const detailProps = (s: ScheduleOverview) => ({
    schedule: s, now, actions, onEdit: () => setEditing(s), onOpenPrompt: () => setPromptOf(s.id),
  });

  const empty = loaded && list.length === 0;
  return (
    <div data-schedules-app={mode} className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
      <SchedulesToolbar filter={filter} onFilter={changeFilter} projects={projects} counts={counts} onNew={() => setEditing(null)} phone={phone} />
      <p data-schedules-summary="" className={cn("flex flex-wrap gap-x-3 gap-y-0.5 pb-2 text-[11.5px] text-text-2", phone ? "px-3" : "px-3")}>
        <span><b className="font-semibold text-foreground">{summary.upcoming}</b> run in the next 24 h</span>
        {summary.attention > 0 && <span className="text-error-ink"><b className="font-semibold">{summary.attention}</b> need attention</span>}
        {failed > 0 && <span className="text-error-ink">{failed} failed</span>}
        <span><b className="font-semibold text-foreground">{bypass}</b> run in Bypass</span>
      </p>

      <div className="flex min-h-0 flex-1 border-t border-border">
        <div className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", phone && "px-2.5 pt-1")} role={phone ? undefined : "grid"} aria-label="Schedules">
          {!loaded && !error && <p className="p-6 text-center text-xs text-text-3">Loading…</p>}
          {error && <p className="p-6 text-center text-xs text-error-ink">{error}</p>}
          {empty && (
            <div className="flex flex-col items-center gap-2 p-10 text-center text-xs text-text-3">
              <CalendarClock className="size-8 opacity-50" />
              No schedules yet. A chat can schedule a reminder, or press New.
            </div>
          )}
          {loaded && !empty && shown.length === 0 && <p className="p-6 text-center text-xs text-text-3">Nothing matches these filters.</p>}
          {!phone && shown.length > 0 && (
            <div className={cn(ROW_GRID, "sticky top-0 z-[1] border-b border-border-soft bg-background py-1.5 text-[10.5px] uppercase tracking-wider text-text-3")}>
              <span /><span>Schedule</span><span>Next run</span><span className="hidden @[860px]:block">Last run</span><span>Mode</span><span>On</span><span />
            </div>
          )}
          {groups.map((g) => (
            <section key={g.id} data-group={g.id}>
              <h3 className={cn("px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider", g.id === "attention" ? "text-error-ink" : "text-text-3", phone && "px-0.5")}>
                {g.label} · {g.items.length}
              </h3>
              {g.items.map((s) => phone ? (
                <ScheduleOverviewCard key={s.id} {...detailProps(s)} onSelect={() => select(s)} />
              ) : (
                <div key={s.id}>
                  <ScheduleOverviewRow {...detailProps(s)} selected={selected === s.id} onSelect={() => select(s)} />
                  {selected === s.id && (
                    <div className="border-b border-border-soft bg-accent-wash/40 px-3 py-3 @[900px]:hidden">
                      <ScheduleOverviewDetail {...detailProps(s)} bare />
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
        {!phone && current && (
          <aside className="hidden w-[340px] shrink-0 overflow-y-auto border-l border-border bg-bg p-3.5 @[900px]:block">
            <ScheduleOverviewDetail {...detailProps(current)} />
          </aside>
        )}
      </div>

      {phone && (
        <BottomSheet open={!!current} onClose={() => setSelected(null)} className="max-h-[85vh] overflow-y-auto">
          {current && <div className="px-3 pb-4"><ScheduleOverviewDetail {...detailProps(current)} /></div>}
        </BottomSheet>
      )}
      <SchedulePromptSheet schedule={promptSchedule} onClose={() => setPromptOf(null)}
        onEdit={() => { if (promptSchedule) setEditing(promptSchedule); setPromptOf(null); }} />
      <ScheduleForm open={editing !== undefined} schedule={editing ?? null} onClose={() => setEditing(undefined)}
        onSaved={() => void useSchedulesOverviewStore.getState().refetch()} />
    </div>
  );
}
