/**
 * The sheet a long-press on a phone task row opens (variant-3 screen 03): the project's statuses
 * as a grid of big buttons, then Urgency (its four values open in place), Reorder… (Move up /
 * Move down inside the task's cell), Snooze until… (its choices open in place), Ask manager about
 * this and Copy link. Swiping the sheet away
 * or tapping the backdrop cancels; every action closes it.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Link, MessageSquare, Moon, Zap } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import { URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { copyTaskLink } from "@/lib/ppm-tasks/open-task-tab";
import { URGENCIES, type Urgency } from "../../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import { TaskStatusGrid } from "./task-status-grid";
import { TaskCode } from "../kit/task-code";
import { TaskSnoozeOptions, type SnoozePatch } from "../task-snooze-options";
import { snoozeBadgeText } from "../kit/task-snooze-badge";

export interface TaskRowActionSheetProps {
  /** The pressed task; null keeps the sheet closed. */
  task: TaskDto | null;
  /** The list spans projects: the header's code names the project (`ppm/12`). */
  showProject?: boolean;
  statuses: TaskProjectSettings["statuses"] | undefined;
  /** The rows above and below in the task's own cell (the only places Reorder can move it). */
  neighbours: { up: TaskDto | null; down: TaskDto | null };
  hasManager: boolean;
  onClose(): void;
  onStatus(task: TaskDto, statusId: string): void;
  onUrgency(task: TaskDto, urgency: Urgency): void;
  onReorder(task: TaskDto, to: { beforeId: string } | { afterId: string }): void;
  onAskManager(task: TaskDto): void;
  /** Snooze or unsnooze; absent, the sheet offers no Snooze. */
  onSnooze?(task: TaskDto, patch: SnoozePatch): void;
}

// Rows at the chip row's 26px minimum (docs/design-guidelines.md rule 3), the user's pick over the 44px rule.
const ITEM = "flex min-h-[26px] w-full items-center gap-3 rounded-lg px-3 py-1 text-left text-[15px] text-text active:bg-surface-hover disabled:opacity-40";

function Item({ icon, children, aside, onClick, disabled, expanded }: {
  icon: ReactNode; children: ReactNode; aside?: ReactNode; onClick(): void; disabled?: boolean; expanded?: boolean;
}) {
  return (
    <button type="button" className={ITEM} onClick={onClick} disabled={disabled} aria-expanded={expanded}>
      <span aria-hidden className="text-text-3 [&_svg]:size-[18px]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside}
    </button>
  );
}

export function TaskRowActionSheet(p: TaskRowActionSheetProps) {
  const { task } = p;
  const [open, setOpen] = useState<"urgency" | "reorder" | "snooze" | null>(null);
  useEffect(() => { setOpen(null); }, [task?.id]);
  const act = (fn: (t: TaskDto) => void) => { if (task) { p.onClose(); fn(task); } };
  return (
    <BottomSheet open={!!task} onClose={p.onClose} className="flex max-h-[88%] flex-col">
      {task && (
        <div role="dialog" aria-label={`Actions for ${task.title}`} data-task-action-sheet={task.id} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
          <p data-task-code-pair="" className="flex min-w-0 items-baseline gap-1.5 px-1 pb-2 text-sm font-medium text-text">
            <TaskCode task={task} viewProject={p.showProject ? null : task.project} className="text-[12.5px]" />
            <span data-task-code-title="" className="min-w-0 flex-1 truncate">{task.title}</span>
          </p>
          <TaskStatusGrid project={task.project} statuses={p.statuses ?? []} currentId={task.statusId}
            onPick={(id) => act((t) => p.onStatus(t, id))} />
          <div className="my-2 h-px bg-border-soft" />
          <Item icon={<Zap />} expanded={open === "urgency"} onClick={() => setOpen(open === "urgency" ? null : "urgency")}
            aside={<span className="text-sm text-text-3">{URGENCY_LABEL[task.effectiveUrgency]}</span>}>Urgency</Item>
          {open === "urgency" && (
            <div className="grid grid-cols-4 gap-2 px-1 pb-2" role="group" aria-label="Urgency">
              {URGENCIES.map((u) => (
                <button key={u} type="button" aria-pressed={task.urgency === u} onClick={() => act((t) => p.onUrgency(t, u))}
                  className={cn("min-h-[26px] rounded-lg border px-1 text-[13px]",
                    task.urgency === u ? "border-accent-wash-border bg-accent-wash font-medium text-text" : "border-border-soft text-text-2")}>
                  {URGENCY_LABEL[u]}
                </button>
              ))}
            </div>
          )}
          <Item icon={<ArrowUpDown />} expanded={open === "reorder"} onClick={() => setOpen(open === "reorder" ? null : "reorder")}
            aside={<ChevronRight className={cn("size-4 text-text-3 transition-transform", open === "reorder" && "rotate-90")} />}>Reorder…</Item>
          {open === "reorder" && (
            <div className="pl-8">
              <Item icon={<ArrowUp />} disabled={!p.neighbours.up} onClick={() => act((t) => p.onReorder(t, { beforeId: p.neighbours.up!.id }))}>Move up</Item>
              <Item icon={<ArrowDown />} disabled={!p.neighbours.down} onClick={() => act((t) => p.onReorder(t, { afterId: p.neighbours.down!.id }))}>Move down</Item>
              {!p.neighbours.up && !p.neighbours.down && <p className="px-3 pb-2 text-xs text-text-3">Order changes only among tasks of the same urgency, importance and project.</p>}
            </div>
          )}
          {p.onSnooze && task.baseGroup !== "closed" && (
            <>
              <Item icon={<Moon />} expanded={open === "snooze"} onClick={() => setOpen(open === "snooze" ? null : "snooze")}
                aside={<span className="min-w-0 truncate text-sm text-text-3">{task.snoozed ? snoozeBadgeText(task) : ""}</span>}>Snooze until…</Item>
              {open === "snooze" && (
                <div className="pb-2 pl-8 pr-1" data-task-action-snooze="">
                  <TaskSnoozeOptions task={task} onPick={(patch) => act((t) => p.onSnooze!(t, patch))} />
                </div>
              )}
            </>
          )}
          {p.hasManager && <Item icon={<MessageSquare />} onClick={() => act(p.onAskManager)}>Ask manager about this</Item>}
          <Item icon={<Link />} onClick={() => act((t) => void copyTaskLink(t))}>Copy link</Item>
        </div>
      )}
    </BottomSheet>
  );
}
