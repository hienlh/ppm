/**
 * One task in the Tasks sidebar list (variant-3 screen 01): status glyph, title on up to two lines,
 * a meta line (Jira key or PR/CI dot, who it waits on and for how long, a Decision/Reply badge,
 * child progress, the project in the all-projects scope, the working-session chip) and importance
 * bars with the assignee on the right. A click previews the task, a double-click keeps its tab.
 */
import type { DragEvent, PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { linkStateView } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { ageShort, memberName } from "@/lib/ppm-tasks/task-format";
import { TaskStatusGlyph } from "./kit/task-status-glyph";
import { TaskTypeBadge } from "./kit/task-type-badge";
import { TaskImportanceBars } from "./kit/task-importance-bars";
import { TaskMemberAvatar } from "./kit/task-member-avatar";
import { TaskWorkingSessionChip } from "./kit/task-working-session-chip";
import { TaskDueLabel } from "./kit/task-due-label";
import type { LinkState, TaskMember } from "../../../shared/ppm-tasks";
import type { TaskDto, TaskWorkingSession } from "../../../shared/ppm-tasks-api";

const TONE_COLOR: Record<string, string> = {
  info: "var(--info)", ok: "var(--success)", bad: "var(--error)", warn: "var(--warning)", idle: "var(--text-3)", merge: "var(--accent-2)",
};

export interface TaskListRowProps {
  task: TaskDto;
  depth: 0 | 1;
  selected: boolean;
  showProject: boolean;
  progress?: { done: number; total: number };
  members?: readonly TaskMember[];
  linkStates?: readonly LinkState[];
  working?: TaskWorkingSession;
  dragging?: boolean;
  /** `keep`: a double-click, which keeps the tab instead of previewing. */
  onSelect(task: TaskDto, keep: boolean): void;
  onOpenChat(task: TaskDto, sessionId: string): void;
  onStartChat(task: TaskDto): void;
  onPointerDown?(e: PointerEvent<HTMLDivElement>, task: TaskDto): void;
}

/** The meta line's external state: the first Jira key, else the first PR's state as a dot (the phone row too). */
export function externalMeta(task: TaskDto, states: readonly LinkState[] | undefined) {
  const jira = task.links.filter((l) => l.kind === "jira");
  if (jira.length) return <span className="font-mono text-[11px]">{jira[0]!.ref}{jira.length > 1 ? ` +${jira.length - 1}` : ""}</span>;
  const pr = task.links.find((l) => l.kind === "pr");
  if (!pr) return null;
  const view = linkStateView(pr, states?.find((s) => s.kind === "pr" && s.ref === pr.ref));
  // A state PPM could not read says so on the task's page; in a narrow row it is only noise.
  if (!view.state || view.state === "…" || view.state.startsWith("state unknown")) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: TONE_COLOR[view.tone] }} />
      <span className="truncate">{view.state}</span>
    </span>
  );
}

export function TaskListRow(p: TaskListRowProps) {
  const { task } = p;
  const waiting = memberName(task.waitingOnMemberId, p.members);
  const assignee = memberName(task.assigneeMemberId, p.members);
  const closed = task.baseGroup === "closed";
  return (
    <div role="option" aria-selected={p.selected} tabIndex={-1} data-task-row={task.id} data-depth={p.depth}
      onClick={() => p.onSelect(task, false)} onDoubleClick={() => p.onSelect(task, true)}
      onPointerDown={p.onPointerDown && p.depth === 0 ? (e) => p.onPointerDown!(e, task) : undefined}
      onDragStart={(e: DragEvent) => e.preventDefault()}
      className={cn(
        "group relative grid cursor-pointer select-none grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2 rounded-md py-1.5 pr-2 text-left",
        p.depth === 1 ? "pl-7" : "pl-2",
        p.selected ? "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-hover",
        p.dragging && "opacity-40",
      )}>
      <span className="pt-[3px]"><TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} name={task.statusName} /></span>
      <div className="min-w-0">
        <div className={cn("line-clamp-2 break-words text-[13px] leading-snug text-text", closed && "text-text-3 line-through", p.depth === 1 && "text-[12.5px]")}>
          {task.title}
        </div>
        {p.depth === 0 && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-3">
            {p.showProject && <span className="max-w-[90px] truncate rounded bg-surface px-1 text-[10.5px] font-medium text-text-2">{task.project}</span>}
            {(task.type === "decision" || task.type === "reply") && <TaskTypeBadge type={task.type} className="text-[11px]" />}
            {externalMeta(task, p.linkStates)}
            {waiting && task.waitingSince ? <span className="truncate text-warning">{waiting} · {ageShort(task.waitingSince)}</span> : null}
            {!waiting && task.dueDate ? <TaskDueLabel dueDate={task.dueDate} className="text-[11px]" /> : null}
            {p.progress && p.progress.total > 0 && <span className="font-mono text-[11px]">{p.progress.done}/{p.progress.total}</span>}
            <TaskWorkingSessionChip working={p.working ?? task.workingSession} check={task.check}
              onOpen={(sid) => p.onOpenChat(task, sid)} onStartChat={() => p.onStartChat(task)} />
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 pt-0.5">
        <TaskImportanceBars importance={task.importance} showLabel={false} />
        {assignee && p.depth === 0 ? <TaskMemberAvatar name={assignee} memberId={task.assigneeMemberId} size="sm" /> : null}
      </div>
    </div>
  );
}
