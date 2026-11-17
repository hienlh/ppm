/**
 * One task in the Tasks sidebar list (variant-3 screen 01): status glyph, the task's code (`#12`, or
 * `ppm/12` in the all-projects scope, where the code names the project) and title on up to two
 * lines, a meta line (Jira key or PR/CI dot, who it waits on and until when — its due date, else
 * how long — with a wait on the user standing out, a Decision/Reply
 * badge, child progress, the working-session chip) and importance
 * bars with the assignee on the right. A click previews the task, a double-click keeps its tab.
 * A right-click opens the row's menu, "Snooze until…" (the picker's date choice opens beside the
 * row); a snoozed row says until when and has its own Unsnooze, a returned one says "Back today".
 */
import { useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { UNSNOOZE_PATCH, snoozeChoices } from "@/lib/ppm-tasks/task-snooze-choices";
import { TaskSnoozeBadge } from "./kit/task-snooze-badge";
import { TaskSnoozePicker } from "./task-snooze-menu";
import { UnsnoozeButton } from "./task-snoozed-section";
import type { SnoozePatch } from "./task-snooze-options";
import { cn } from "@/lib/utils";
import { linkStateView } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { memberName, taskWaiting } from "@/lib/ppm-tasks/task-format";
import { TaskStatusGlyph } from "./kit/task-status-glyph";
import { TaskTypeBadge } from "./kit/task-type-badge";
import { TaskImportanceBars } from "./kit/task-importance-bars";
import { TaskMemberAvatar } from "./kit/task-member-avatar";
import { TaskWorkingSessionChip } from "./kit/task-working-session-chip";
import { TaskDueLabel } from "./kit/task-due-label";
import { TaskWaitingLabel } from "./kit/task-waiting-label";
import { TaskCode } from "./kit/task-code";
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
  /** Snooze or unsnooze the task; absent, the row has no menu. */
  onSnooze?(task: TaskDto, patch: SnoozePatch): void;
}

/** The row's right-click menu: the snooze choices, "Pick a date…" opening the picker beside the row. */
function SnoozeRowMenu({ task, onSnooze, children }: { task: TaskDto; onSnooze(task: TaskDto, patch: SnoozePatch): void; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  if (task.baseGroup === "closed") return <>{children}</>;
  const choices = snoozeChoices(task, localYmd());
  return (
    <div ref={anchor}>
      <ContextMenu>
        {/* A plain box: the row keeps its own handlers (drag, click) and the right-click bubbles here. */}
        <ContextMenuTrigger asChild><div data-task-row-menu-trigger="">{children}</div></ContextMenuTrigger>
        <ContextMenuContent data-task-row-menu={task.id} className="min-w-[220px]">
          <ContextMenuLabel className="text-[11px] uppercase tracking-wide text-text-3">Snooze until…</ContextMenuLabel>
          {choices.filter((c) => c.id !== "clear").map((c) => (
            <ContextMenuItem key={c.id} disabled={c.disabled} data-snooze-choice={c.id}
              onSelect={() => (c.patch ? onSnooze(task, c.patch) : setPicking(true))}>
              <span className="flex-1">{c.label}</span>
              {c.detail && <span className="ml-3 text-[11px] text-text-3">{c.detail}</span>}
            </ContextMenuItem>
          ))}
          {choices.some((c) => c.id === "clear") && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem data-snooze-choice="clear" onSelect={() => onSnooze(task, UNSNOOZE_PATCH)}>Unsnooze</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <TaskSnoozePicker task={task} open={picking} onOpenChange={setPicking} anchorRef={anchor} onSnooze={(patch) => onSnooze(task, patch)} />
    </div>
  );
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
  const row = <TaskListRowBody {...p} />;
  return p.onSnooze ? <SnoozeRowMenu task={p.task} onSnooze={p.onSnooze}>{row}</SnoozeRowMenu> : row;
}

function TaskListRowBody(p: TaskListRowProps) {
  const { task } = p;
  const waiting = taskWaiting(task, p.members);
  const assignee = memberName(task.assigneeMemberId, p.members);
  const closed = task.baseGroup === "closed";
  return (
    <div role="option" aria-selected={p.selected} tabIndex={-1} data-task-row={task.id} data-depth={p.depth}
      onClick={() => p.onSelect(task, false)} onDoubleClick={() => p.onSelect(task, true)}
      // A snoozed row sits outside the urgency groups: there is nowhere to drag it.
      onPointerDown={p.onPointerDown && p.depth === 0 && !task.snoozed ? (e) => p.onPointerDown!(e, task) : undefined}
      onDragStart={(e: DragEvent) => e.preventDefault()}
      className={cn(
        "group relative grid cursor-pointer select-none grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2 rounded-md py-1.5 pr-2 text-left",
        p.depth === 1 ? "pl-7" : "pl-2",
        p.selected ? "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-hover",
        p.dragging && "opacity-40",
      )}>
      <span className="pt-[3px]"><TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} name={task.statusName} /></span>
      <div className="min-w-0">
        <div data-task-code-pair="" className={cn("line-clamp-2 break-words text-[13px] leading-snug text-text", closed && "text-text-3 line-through", p.depth === 1 && "text-[12.5px]")}>
          <TaskCode task={task} viewProject={p.showProject ? null : task.project} inRow tabIndex={-1} className="mr-1" /><span data-task-code-title="">{task.title}</span>
        </div>
        {p.depth === 0 && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-3">
            {(task.type === "decision" || task.type === "reply") && <TaskTypeBadge type={task.type} className="text-[11px]" />}
            {externalMeta(task, p.linkStates)}
            {waiting ? <TaskWaitingLabel detail={waiting} untilApart className="text-[11.5px]" />
              : task.dueDate ? <TaskDueLabel dueDate={task.dueDate} className="text-[11px]" /> : null}
            <TaskSnoozeBadge task={task} />
            {p.progress && p.progress.total > 0 && <span className="font-mono text-[11px]">{p.progress.done}/{p.progress.total}</span>}
            <TaskWorkingSessionChip working={p.working ?? task.workingSession} check={task.check}
              onOpen={(sid) => p.onOpenChat(task, sid)} onStartChat={() => p.onStartChat(task)} />
            {task.snoozed && p.onSnooze && <UnsnoozeButton onClick={() => p.onSnooze!(task, UNSNOOZE_PATCH)} />}
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
