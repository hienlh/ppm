/**
 * The task page's reminders: each one-shot schedule this task owns, as "Reminder · today 18:30
 * London" with how far off it is, which chat it goes to and its permission mode, plus Open in
 * Schedules and Remove. Read from the shared schedules list, so a reminder the AI set with
 * `session_schedule_create` shows here the moment it exists. Nothing is drawn while there is none.
 */
import { CalendarClock, ExternalLink, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useScheduleActions } from "@/components/schedules/use-schedule-actions";
import { openSchedules } from "@/components/schedules/open-schedules";
import { ICON_BUTTON, PermissionPill } from "@/components/schedules/schedules-ui";
import { useSchedulesFeed, useSchedulesOverviewStore } from "@/stores/schedules-overview-store";
import { nextRunLabel } from "@/lib/schedules/schedules-view";
import { scheduleAttention } from "../../../shared/schedule-attention";

export function TaskRemindersCard({ taskId, className }: { taskId: string; className?: string }) {
  useSchedulesFeed();
  const list = useSchedulesOverviewStore((s) => s.list);
  const now = useSchedulesOverviewStore((s) => s.now);
  const actions = useScheduleActions();
  const reminders = list.filter((s) => s.task_id === taskId);
  if (reminders.length === 0) return null;
  return (
    <div data-task-reminders="" className={cn("flex flex-col gap-1.5", className)}>
      {reminders.map((r) => {
        const next = nextRunLabel(r, now);
        const problem = scheduleAttention(r, now);
        return (
          <div key={r.id} data-task-reminder={r.id}
            className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2", problem ? "border-error/45 bg-error/10" : "border-accent-wash-border bg-accent-wash")}>
            <CalendarClock aria-hidden className="mt-0.5 size-[18px] shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">
                {r.enabled ? `Reminder · ${next.main}` : "Reminder · off"}
                {r.kind === "session" && r.recurring === 1 && <span className="font-normal text-text-2"> · repeats</span>}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-text-2">
                {next.sub && <span>{next.sub.replace(" · once", "")}</span>}
                <span>· to {r.target_title ?? "the manager chat"}</span>
                <PermissionPill mode={r.effective_permission_mode} />
                {problem && <span className="text-error-ink">· {problem.text}</span>}
              </p>
            </div>
            <button type="button" aria-label="Open in Schedules" title="Open in Schedules" className={ICON_BUTTON} onClick={() => openSchedules({ select: r.id })}><ExternalLink /></button>
            <button type="button" aria-label="Remove reminder" title="Remove reminder" className={cn(ICON_BUTTON, "hover:text-error")} onClick={() => void actions.remove(r)}><X /></button>
          </div>
        );
      })}
    </div>
  );
}
