/**
 * One schedule as a phone card: name and switch, then project, permission pill, task and chat,
 * then the next run with Open prompt and Run now in reach of the thumb, then the last run. A tap
 * opens the schedule's details in a sheet; a long press opens its actions (the adaptive menu's
 * bottom sheet), so the two never compete for the same gesture.
 */
import { ClipboardCheck, FileText, Play } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { cn } from "@/lib/utils";
import { scheduleAttention } from "../../../shared/schedule-attention";
import { lastRunLabel, nextRunLabel, projectLabel } from "@/lib/schedules/schedules-view";
import { ScheduleActionsMenu, type ScheduleRowProps } from "./schedule-overview-row";
import { ICON_BUTTON, KindIcon, PermissionPill, ProjectTag, RunStatusLine } from "./schedules-ui";

export function ScheduleOverviewCard({ schedule: s, now, actions, onSelect, onOpenPrompt, onEdit }: Omit<ScheduleRowProps, "selected">) {
  const next = nextRunLabel(s, now);
  const last = lastRunLabel(s, now);
  const attention = scheduleAttention(s, now);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-schedule-card={s.id}
          data-attention={attention?.kind}
          className={cn(
            "mb-2 select-none rounded-xl border bg-panel px-3 py-2.5",
            attention ? "border-error/45" : "border-border",
            !s.enabled && "opacity-60",
          )}
        >
          <div className="flex items-center gap-2">
            <KindIcon kind={s.kind} />
            {/* The tap target: a real button, which the adaptive menu leaves alone after a long press. */}
            <button type="button" data-tap-area="" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[14.5px] font-medium">{s.name}</button>
            <Switch aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`} checked={!!s.enabled} onCheckedChange={(v) => void actions.setEnabled(s, v)} />
          </div>
          <button type="button" data-tap-area="" onClick={onSelect} className="mt-1.5 flex w-full flex-wrap items-center gap-1.5 text-left">
            <ProjectTag name={projectLabel(s)} />
            <PermissionPill mode={s.effective_permission_mode} />
            {s.task && (
              <span className="inline-flex h-[18px] items-center gap-0.5 rounded-[5px] bg-accent-wash px-1.5 text-[11px] font-medium text-primary">
                <ClipboardCheck aria-hidden className="size-3" />{s.task.ref}
              </span>
            )}
            {s.kind === "session" && <span className="truncate text-[11.5px] text-text-3">→ {s.target_title ?? "its chat"}</span>}
          </button>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button type="button" data-tap-area="" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[13px]">
              <b className="font-medium">{next.main}</b>{next.sub && <span className="text-text-3"> · {next.sub}</span>}
            </button>
            <div className="flex gap-1">
              <button type="button" aria-label={s.kind === "script" ? "Open script" : "Open prompt"} className={ICON_BUTTON} onClick={onOpenPrompt}><FileText /></button>
              <button type="button" aria-label="Run now" className={ICON_BUTTON} onClick={() => void actions.runNow(s)}><Play /></button>
            </div>
          </div>
          <div className="mt-1"><RunStatusLine {...last} /></div>
        </div>
      </ContextMenuTrigger>
      <ScheduleActionsMenu schedule={s} now={now} actions={actions} onOpenPrompt={onOpenPrompt} onEdit={onEdit} />
    </ContextMenu>
  );
}
