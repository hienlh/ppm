/**
 * One task in the phone list (variant-3 screen 03): a 62px row with a 44px status cell (a tap there
 * opens the same sheet as a long-press), the title on one line, a meta line (project in the
 * all-projects scope, Decision/Reply badge, Jira key or PR/CI dot, who it waits on and for how
 * long, child progress, the working-session chip) and a chevron. The meta line never wraps or
 * widens the row: the working-session chip gives way first, then the waiting text.
 */
import { ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { ageShort, memberName } from "@/lib/ppm-tasks/task-format";
import type { LinkState, TaskMember } from "../../../../shared/ppm-tasks";
import type { TaskDto, TaskWorkingSession } from "../../../../shared/ppm-tasks-api";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskTypeBadge } from "../kit/task-type-badge";
import { TaskWorkingSessionChip } from "../kit/task-working-session-chip";
import { externalMeta } from "../task-list-row";
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
}

export function TaskRowMobile(p: TaskRowMobileProps) {
  const { task } = p;
  const press = useTaskRowLongPress(() => p.onActions(task));
  const waiting = memberName(task.waitingOnMemberId, p.members);
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
        <button type="button" tabIndex={-1} className={cn("block w-full truncate text-left text-[15px] leading-snug text-text", closed && "text-text-3 line-through")}>{task.title}</button>
        {/* The meta line is not clipped: the chat chip's 44px hit area reaches past it; its items shrink instead. */}
        {p.depth === 0 && (
          <div className="mt-1 flex min-w-0 flex-nowrap items-center gap-2 whitespace-nowrap text-xs text-text-3">
            {p.showProject && <span className="max-w-[80px] truncate rounded bg-surface px-1 text-[11px] font-medium text-text-2">{task.project}</span>}
            {(task.type === "decision" || task.type === "reply") && <TaskTypeBadge type={task.type} className="text-[11px]" />}
            {externalMeta(task, p.linkStates)}
            {waiting && task.waitingSince ? <span className="min-w-0 shrink-[2] truncate text-warning">{waiting} {ageShort(task.waitingSince)}</span> : null}
            {p.progress && p.progress.total > 0 && <span className="font-mono text-[11px]">{p.progress.done}/{p.progress.total}</span>}
            <TaskWorkingSessionChip working={p.working ?? task.workingSession} check={task.check} className="shrink-[3]"
              onOpen={(sid) => p.onOpenChat(task, sid)} onStartChat={() => p.onStartChat(task)} />
          </div>
        )}
      </div>
      <ChevronRight aria-hidden className="size-4 text-text-3" />
    </div>
  );
}
