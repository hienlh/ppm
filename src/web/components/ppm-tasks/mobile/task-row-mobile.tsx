/**
 * One task in the phone list (variant-3 screen 03): a 62px row with a 44px status cell (a tap there
 * opens the same sheet as a long-press), the task's code and title on one line (the title gives
 * way, never the code; in the all-projects scope the code names the project), a meta line (Decision/Reply badge, Jira key or PR/CI dot, who it waits on and until
 * when, child progress, the working-session chip) and a chevron. The meta line never wraps or
 * widens the row: the working-session chip gives way first, then the waiting text.
 */
import { ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { taskWaiting } from "@/lib/ppm-tasks/task-format";
import type { LinkState, TaskMember } from "../../../../shared/ppm-tasks";
import type { TaskDto, TaskWorkingSession } from "../../../../shared/ppm-tasks-api";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskTypeBadge } from "../kit/task-type-badge";
import { TaskWorkingSessionChip } from "../kit/task-working-session-chip";
import { TaskCode } from "../kit/task-code";
import { TaskWaitingLabel } from "../kit/task-waiting-label";
import { externalMeta } from "../task-list-row";
import { TaskSnoozeBadge } from "../kit/task-snooze-badge";
import { UnsnoozeButton } from "../task-snoozed-section";
import { useTaskRowLongPress } from "./use-task-row-long-press";

export interface TaskRowMobileProps {
  task: TaskDto;
  depth: 0 | 1;
  selected: boolean;
  showProject: boolean;
  progress?: { done: number; total: number };
  members?: readonly TaskMember[];
  linkStates?: readonly LinkState[];
  working?: TaskWorkingSession;
  onOpen(task: TaskDto): void;
  onActions(task: TaskDto): void;
  onOpenChat(task: TaskDto, sessionId: string): void;
  onStartChat(task: TaskDto): void;
  /** A snoozed row's Unsnooze. */
  onUnsnooze?(task: TaskDto): void;
}

export function TaskRowMobile(p: TaskRowMobileProps) {
  const { task } = p;
  const press = useTaskRowLongPress(() => p.onActions(task));
  const waiting = taskWaiting(task, p.members);
  const snoozeShown = task.snoozed || task.resurfacedToday;
  const closed = task.baseGroup === "closed";
  return (
    <div role="button" tabIndex={0} aria-current={p.selected || undefined} data-task-row={task.id} data-depth={p.depth}
      onClick={() => { if (!press.swallowClick()) p.onOpen(task); }}
      // Only the row's own keys: Enter on the status button or the chat chip inside is theirs.
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); p.onOpen(task); } }}
      {...press.handlers}
      className={cn(
        "grid min-h-[62px] cursor-pointer select-none grid-cols-[44px_minmax(0,1fr)_18px] items-center pr-3 [-webkit-touch-callout:none] active:bg-surface-hover",
        p.depth === 1 && "min-h-[52px] pl-6",
        p.selected && "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)]",
      )}>
      <button type="button" aria-label={`Status: ${task.statusName}. Change`} title={task.statusName}
        onClick={(e) => { e.stopPropagation(); p.onActions(task); }}
        className="grid size-11 place-items-center rounded-full active:bg-surface-hover">
        <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} size="lg" />
      </button>
      <div className="min-w-0 py-2">
        {/* A button only so a touch on the title stays here: the browser's touch adjustment would
            otherwise hand a tap near the chat chip's 44px hit area to the chip. The row opens it. */}
        <div data-task-code-pair="" className="flex min-w-0 items-baseline gap-1">
          <TaskCode task={task} viewProject={p.showProject ? null : task.project} inRow className="text-[12.5px]" />
          <button type="button" tabIndex={-1} data-task-code-title="" className={cn("block min-w-0 flex-1 truncate text-left text-[15px] leading-snug text-text", closed && "text-text-3 line-through")}>{task.title}</button>
        </div>
        {/* The meta line is not clipped: the chat chip's 44px hit area reaches past it; its items shrink instead. */}
        {p.depth === 0 && (
          <div className="mt-1 flex min-w-0 flex-nowrap items-center gap-2 whitespace-nowrap text-xs text-text-3">
            {(task.type === "decision" || task.type === "reply") && <TaskTypeBadge type={task.type} className="text-[11px]" />}
            {externalMeta(task, p.linkStates)}
            {/* A snoozed row also holds Unsnooze: the wait says only on whom, the snooze only its day. */}
            {waiting ? <TaskWaitingLabel detail={waiting} short={task.snoozed} className="shrink" /> : null}
            {/* Beside the wait, never over it: both give way with "…", the chat chip before either. */}
            {snoozeShown && <TaskSnoozeBadge task={task} compact={task.snoozed} className="shrink text-xs" />}
            {p.progress && p.progress.total > 0 && <span className="font-mono text-[11px]">{p.progress.done}/{p.progress.total}</span>}
            {/* Out of the daily list, its chat is one tap away on its page: the row keeps room for the rest. */}
            {!task.snoozed && (
              <TaskWorkingSessionChip working={p.working ?? task.workingSession} check={task.check} className={waiting || snoozeShown ? "shrink-[8]" : "shrink-[3]"}
                onOpen={(sid) => p.onOpenChat(task, sid)} onStartChat={() => p.onStartChat(task)} />
            )}
            {task.snoozed && p.onUnsnooze && <UnsnoozeButton onClick={() => p.onUnsnooze!(task)} />}
          </div>
        )}
      </div>
      <ChevronRight aria-hidden className="size-4 text-text-3" />
    </div>
  );
}
