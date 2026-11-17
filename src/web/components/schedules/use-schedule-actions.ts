/**
 * What a schedule row, card or detail can do: run it now, turn it on or off, dismiss its problem,
 * delete it, and open what it belongs to (its task, its chat, the chat of its last run). Every
 * write puts the server's answer into the shared list at once, so the rail's count and dot follow
 * without waiting for the next read.
 */
import { useMemo } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { openSessionAnywhere } from "@/lib/open-session-anywhere";
import { openTask } from "@/lib/ppm-tasks/open-task";
import { useSchedulesOverviewStore } from "@/stores/schedules-overview-store";
import { scheduleProblem } from "../../../shared/schedule-attention";
import type { ScheduleOverview } from "../../../types/scheduler";
import { projectLabel } from "@/lib/schedules/schedules-view";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export interface ScheduleActions {
  runNow(s: ScheduleOverview): Promise<void>;
  setEnabled(s: ScheduleOverview, enabled: boolean): Promise<void>;
  dismiss(s: ScheduleOverview): Promise<void>;
  remove(s: ScheduleOverview): Promise<void>;
  openTask(s: ScheduleOverview): void;
  /** The chat a reminder goes into, or the chat its last run opened. */
  openChat(s: ScheduleOverview): void;
  /** One run's chat, of the schedule's project. */
  openChatId(s: ScheduleOverview, sessionId: string): void;
  chatOf(s: ScheduleOverview): string | null;
}

/** The chat a schedule is about: a reminder's target, else the chat its last run used. */
function chatOf(s: ScheduleOverview): string | null {
  if (s.kind === "session") return s.target_session_id;
  return s.last_run?.session_id ?? s.session_id;
}

function openChatOf(s: ScheduleOverview, sessionId: string): void {
  void openSessionAnywhere(projectLabel(s), sessionId, s.provider_id).then((ok) => {
    if (!ok) toast.error(`${projectLabel(s)} is not a project in this PPM any more.`);
  });
}

export function useScheduleActions(): ScheduleActions {
  const put = useSchedulesOverviewStore((s) => s.put);
  const drop = useSchedulesOverviewStore((s) => s.remove);
  const refetch = useSchedulesOverviewStore((s) => s.refetch);

  return useMemo<ScheduleActions>(() => ({
    async runNow(s) {
      try {
        const res = await api.post<{ runId: number | null; wasRunning: boolean }>(`/api/schedules/${s.id}/run-now`);
        if (s.kind === "session") toast.success("Queued: it is sent once its chat is idle");
        else if (res.runId !== null) toast.success(`Run #${res.runId} started${res.wasRunning ? " (the previous run is still going)" : ""}`);
        else toast.success(s.mode === "always-on" ? "Restarting" : "Tick started");
      } catch (e) {
        toast.error(message(e, "Could not run it"));
      }
      void refetch();
    },
    async setEnabled(s, enabled) {
      try {
        put(await api.patch<ScheduleOverview>(`/api/schedules/${s.id}`, { enabled }));
      } catch (e) {
        toast.error(message(e, "Could not change it"));
      }
    },
    async dismiss(s) {
      const problem = scheduleProblem(s);
      if (!problem) return;
      try {
        put(await api.post<ScheduleOverview>(`/api/schedules/${s.id}/dismiss`, { key: problem.key }));
      } catch (e) {
        toast.error(message(e, "Could not dismiss it"));
        void refetch();
      }
    },
    async remove(s) {
      if (!window.confirm(`Delete the schedule "${s.name}"? It will not run again.`)) return;
      try {
        await api.del(`/api/schedules/${s.id}`);
        drop(s.id);
        toast.success("Schedule deleted");
      } catch (e) {
        toast.error(message(e, "Could not delete it"));
      }
    },
    openTask(s) {
      if (s.task) openTask({ id: s.task.id, project: s.task.project, title: s.task.title });
    },
    openChat(s) {
      const id = chatOf(s);
      if (id) openChatOf(s, id);
    },
    openChatId: openChatOf,
    chatOf,
  }), [put, drop, refetch]);
}
