/**
 * One schedule as a row of the Schedules window: kind, name with its project, chat and task, the
 * next run on its own clock, the last run, the permission pill, an on/off switch, and Open prompt
 * and Run now. The columns follow the window's width (`@container`): below 860px the last run
 * moves under the name. A click selects the row; a right-click (a long press on touch) opens the
 * same actions as a menu.
 */
import { ClipboardCheck, FileText, Play } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { cn } from "@/lib/utils";
import { scheduleAttention } from "../../../shared/schedule-attention";
import { lastRunLabel, nextRunLabel, projectLabel } from "@/lib/schedules/schedules-view";
import type { ScheduleOverview } from "../../../types/scheduler";
import { ICON_BUTTON, KindIcon, PermissionPill, ProjectTag, RunStatusLine } from "./schedules-ui";
import type { ScheduleActions } from "./use-schedule-actions";

/** Shared by the header row so the two always line up. */
export const ROW_GRID = cn(
  "grid items-center gap-x-2.5 px-3",
  "grid-cols-[16px_minmax(0,1fr)_118px_64px_36px_52px]",
  "@[860px]:grid-cols-[16px_minmax(0,1fr)_150px_160px_70px_36px_52px]",
);

export interface ScheduleRowProps {
  schedule: ScheduleOverview;
  now: number;
  selected: boolean;
  actions: ScheduleActions;
  onSelect: () => void;
  onOpenPrompt: () => void;
  onEdit: () => void;
}

export function ScheduleOverviewRow({ schedule: s, now, selected, actions, onSelect, onOpenPrompt, onEdit }: ScheduleRowProps) {
  const next = nextRunLabel(s, now);
  const last = lastRunLabel(s, now);
  const attention = scheduleAttention(s, now);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          aria-selected={selected}
          data-schedule-row={s.id}
          data-attention={attention?.kind}
          onClick={onSelect}
          className={cn(
            ROW_GRID, "min-h-[46px] cursor-pointer select-none border-b border-border-soft py-1.5 hover:bg-surface-hover",
            selected && "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)] hover:bg-accent-wash",
            !s.enabled && "opacity-60",
          )}
        >
          <KindIcon kind={s.kind} />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium">{s.name}</p>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-text-3">
              <ProjectTag name={projectLabel(s)} />
              {s.kind === "session" && <span className="truncate">→ {s.target_title ?? "its chat"}</span>}
              {s.task && (
                <span className="inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-[5px] bg-accent-wash px-1.5 text-[10.5px] font-medium text-primary">
                  <ClipboardCheck aria-hidden className="size-3" />{s.task.ref}
                </span>
              )}
              <RunStatusLine {...last} className="@[860px]:hidden" />
            </div>
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{next.main}</p>
            {next.sub && <p className="truncate text-[11px] text-text-3">{next.sub}</p>}
          </div>
          <div className="hidden min-w-0 @[860px]:block"><RunStatusLine {...last} /></div>
          <div><PermissionPill mode={s.effective_permission_mode} /></div>
          <div onClick={(e) => e.stopPropagation()}>
            <Switch aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`} checked={!!s.enabled} onCheckedChange={(v) => void actions.setEnabled(s, v)} />
          </div>
          <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            <button type="button" aria-label={s.kind === "script" ? "Open script" : "Open prompt"} title={s.kind === "script" ? "Open script" : "Open prompt"} className={ICON_BUTTON} onClick={onOpenPrompt}><FileText /></button>
            <button type="button" aria-label="Run now" title="Run now" className={ICON_BUTTON} onClick={() => void actions.runNow(s)}><Play /></button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ScheduleActionsMenu schedule={s} now={now} actions={actions} onOpenPrompt={onOpenPrompt} onEdit={onEdit} />
    </ContextMenu>
  );
}

/** The actions of one schedule as a menu: right-click on a desktop, a bottom sheet on a long press. */
export function ScheduleActionsMenu({ schedule: s, now, actions, onOpenPrompt, onEdit }: {
  schedule: ScheduleOverview;
  now: number;
  actions: ScheduleActions;
  onOpenPrompt: () => void;
  onEdit: () => void;
}) {
  const attention = scheduleAttention(s, now);
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => void actions.runNow(s)}>Run now</ContextMenuItem>
      <ContextMenuItem onClick={onOpenPrompt}>{s.kind === "script" ? "Open script" : "Open prompt"}</ContextMenuItem>
      {s.task && <ContextMenuItem onClick={() => actions.openTask(s)}>Open task {s.task.ref}</ContextMenuItem>}
      {actions.chatOf(s) && <ContextMenuItem onClick={() => actions.openChat(s)}>Open chat</ContextMenuItem>}
      <ContextMenuItem onClick={onEdit}>Edit</ContextMenuItem>
      <ContextMenuItem onClick={() => void actions.setEnabled(s, !s.enabled)}>{s.enabled ? "Turn off" : "Turn on"}</ContextMenuItem>
      {attention && <ContextMenuItem onClick={() => void actions.dismiss(s)}>Dismiss “{attention.text}”</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => void actions.remove(s)}>Delete</ContextMenuItem>
    </ContextMenuContent>
  );
}
