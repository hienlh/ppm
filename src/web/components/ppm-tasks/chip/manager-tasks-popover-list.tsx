/**
 * The compact "what to do first" list the manager chat's Tasks chip opens (variant-3 screen 00):
 * the project's open tasks grouped by urgency, each row its status glyph, code (`#12`), title, status, due date
 * and working-session chip (a waiting task says on whom and until when instead of its status), at most `CHIP_LIST_LIMIT` rows with "<m> more" and "Show in sidebar"
 * at the foot. One line per row in the desktop popover, two lines (60px) in the phone's sheet.
 * "Waiting on you" in the header narrows the list to the tasks waiting on the user.
 *
 * A row shows the task's quick view and the list stays open: on a desktop a popover beside the
 * list (`TaskPeekPopover`), below `md` a page of this same sheet with a back button to the list.
 * The quick view edits the usual fields in place and has Open chat and the task's full page (a
 * window on a desktop, Full screen on a phone); neither touches the sidebar. Another row moves
 * the quick view to that task, Escape closes it before the list, a press outside both closes both.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ListTodo, PanelRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePpmTaskLinkStates, usePpmTaskList } from "@/hooks/use-ppm-tasks";
import { URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { groupTasks } from "@/lib/ppm-tasks/task-list-view";
import { taskWaiting } from "@/lib/ppm-tasks/task-format";
import { isWaitingOnMe } from "../../../../shared/ppm-tasks-waiting";
import { openTaskChat, workingProvider, type TaskTabTarget } from "@/lib/ppm-tasks/open-task-tab";
import { openTask as openTaskAnywhere, openTaskFullScreen } from "@/lib/ppm-tasks/open-task";
import { revealTaskInSidebar } from "@/lib/ppm-tasks/reveal-task-in-sidebar";
import { NO_PEEK, taskPeekStep, type TaskPeekEvent } from "@/lib/ppm-tasks/task-peek-state";
import type { PeekSide } from "@/lib/ppm-tasks/task-peek-placement";
import type { Urgency } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { FooterButton, FooterPopoverFooter, FooterPopoverHeader } from "@/components/chat/footer-popover";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskDueLabel } from "../kit/task-due-label";
import { TaskWaitingLabel } from "../kit/task-waiting-label";
import { TaskWaitingOnMeToggle } from "../kit/task-waiting-on-me-toggle";
import { TaskWorkingSessionChip } from "../kit/task-working-session-chip";
import { TaskCode } from "../kit/task-code";
import { TaskPeekPopover } from "../peek/task-peek-popover";
import { TaskPeekBody } from "../peek/task-peek-body";

export const CHIP_LIST_LIMIT = 8;

/** Beside the list, then below or above it when the chat leaves no room at either side. */
const LIST_PEEK_SIDES: readonly PeekSide[] = ["right", "left", "bottom", "top"];

export interface ChipListView {
  groups: Array<{ urgency: Urgency; tasks: TaskDto[] }>;
  /** Open top-level tasks left out by the limit. */
  more: number;
  ids: string[];
}

/**
 * The rows the chip shows: open top-level tasks in "what to do first" order, cut at `limit`. With
 * `flat`, a child task is a row of its own even when its parent is listed (the "Waiting on you"
 * view, where a child waiting on the user must not hide under a parent that does not).
 */
export function chipListView(tasks: readonly TaskDto[], limit = CHIP_LIST_LIMIT, flat = false): ChipListView {
  const open = tasks.filter((t) => t.baseGroup !== "closed" && t.deletedAt === null);
  const groups: ChipListView["groups"] = [];
  let shown = 0;
  let total = 0;
  for (const g of groupTasks(flat ? open.map((t) => ({ ...t, parentId: null })) : open, new Set())) {
    const top = g.rows.filter((r) => r.depth === 0).map((r) => r.task);
    total += top.length;
    const take = top.slice(0, Math.max(0, limit - shown));
    shown += take.length;
    if (take.length) groups.push({ urgency: g.urgency, tasks: take });
  }
  return { groups, more: total - shown, ids: groups.flatMap((g) => g.tasks.map((t) => t.id)) };
}

const targetOf = (t: TaskDto): TaskTabTarget => ({ id: t.id, project: t.project, title: t.title, number: t.number });

export function ManagerTasksPopoverList({ project, total, onClose }: { project: string; total: number; onClose(): void }) {
  const { tasks, loading, error } = usePpmTaskList({ project, closed: false });
  // "Waiting on you" narrows the list to the open tasks waiting on the user (children included).
  const [mineOnly, setMineOnly] = useState(false);
  const mine = useMemo(() => tasks.filter((t) => t.deletedAt === null && isWaitingOnMe(t)), [tasks]);
  const view = useMemo(() => (mineOnly ? chipListView(mine, CHIP_LIST_LIMIT, true) : chipListView(tasks)), [tasks, mine, mineOnly]);
  // The chip counts child tasks too; whatever the list leaves out is "more" in the sidebar.
  const more = mineOnly ? view.more : Math.max(view.more, total - view.ids.length);
  const live = usePpmTaskLinkStates(view.ids, project);
  const mobile = useIsMobile();

  const [peek, setPeek] = useState(NO_PEEK);
  const step = (event: TaskPeekEvent) => {
    const next = taskPeekStep(peek, event);
    setPeek(next.state);
    if (next.closeList) onClose();
  };
  // The task the quick view shows, as the list last had it: a task closed from the quick view
  // leaves this open-tasks list, and the quick view keeps showing it.
  const lastTarget = useRef<TaskTabTarget | null>(null);
  const listed = peek.taskId ? tasks.find((t) => t.id === peek.taskId) : undefined;
  if (listed) lastTarget.current = targetOf(listed);
  const target: TaskTabTarget | null = !peek.taskId ? null
    : lastTarget.current?.id === peek.taskId ? lastTarget.current : { id: peek.taskId, project, title: "Task" };

  const listRef = useRef<HTMLDivElement>(null);
  // The popover the list sits in: what the quick view stays clear of.
  const panelRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { panelRef.current = listRef.current?.closest<HTMLElement>("[data-footer-popover]") ?? listRef.current; });
  // The row clicked: what the quick view lines up with.
  const rowRef = useRef<HTMLElement | null>(null);

  const showTask = (task: TaskDto, row: HTMLElement | null) => {
    rowRef.current = row;
    step({ type: "row", taskId: task.id, toggle: !mobile });
  };
  // The task's full page; the sidebar is left as it is.
  const openWindow = (task: TaskTabTarget) => { onClose(); openTaskAnywhere(task); };
  const openFullScreen = (task: TaskTabTarget) => { onClose(); openTaskFullScreen(task); };
  const showInSidebar = () => { onClose(); revealTaskInSidebar({ project }, { openList: true }); };

  if (mobile && target) {
    return <TaskPeekBody key={target.id} target={target} layout="sheet" onBack={() => step({ type: "back" })} onLeave={onClose} onOpenPage={openFullScreen} />;
  }

  return (
    <>
      <FooterPopoverHeader>
        <ListTodo aria-hidden className="size-3.5 shrink-0 text-primary" />
        <b className="text-[13px] font-semibold max-md:text-sm">Tasks</b>
        <span className="rounded bg-surface px-1.5 font-mono text-[11px] text-text-3">{total}</span>
        <span className="min-w-0 flex-1 truncate text-text-3 max-md:text-xs">{project} · what to do first</span>
        <TaskWaitingOnMeToggle on={mineOnly} count={mine.length} onToggle={() => setMineOnly((on) => !on)} />
      </FooterPopoverHeader>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" data-manager-tasks-list="">
        {error ? <p className="px-3 py-3 text-error">{error}</p>
          : loading && tasks.length === 0 ? <p className="px-3 py-3 text-text-3">Loading tasks…</p>
          : view.groups.length === 0 ? <p className="px-3 py-3 text-text-3 max-md:px-4">{mineOnly ? "Nothing is waiting on you" : "No open tasks"}</p>
          : view.groups.map((g) => (
            <section key={g.urgency} aria-label={URGENCY_LABEL[g.urgency]}>
              <h4 className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-3 max-md:px-4">{URGENCY_LABEL[g.urgency]}</h4>
              <ul>
                {g.tasks.map((t) => (
                  <ChipRow key={t.id} task={t} working={live[t.id]?.workingSession ?? t.workingSession} selected={!mobile && peek.taskId === t.id}
                    onOpen={(row) => showTask(t, row)}
                    onOpenChat={(sid) => {
                      onClose();
                      const now = { ...t, workingSession: live[t.id]?.workingSession ?? t.workingSession };
                      openTaskChat(t.project, sid, workingProvider(now), now);
                    }} />
                ))}
              </ul>
            </section>
          ))}
      </div>
      <FooterPopoverFooter>
        <span className="min-w-0 truncate px-1 text-text-3 max-md:text-xs">
          {more > 0 ? `${more} more` : ""}
          <span className="md:hidden">{more > 0 ? " · " : ""}tap a task to see it</span>
        </span>
        <FooterButton className="ml-auto" onClick={showInSidebar}><PanelRight />Show in sidebar</FooterButton>
      </FooterPopoverFooter>
      {!mobile && target && (
        <TaskPeekPopover target={target} avoidRef={panelRef} alignRef={rowRef} sides={LIST_PEEK_SIDES}
          onClose={() => step({ type: "escape" })} onLeave={onClose} onOpenWindow={openWindow} />
      )}
    </>
  );
}

function ChipRow({ task, working, selected, onOpen, onOpenChat }: {
  task: TaskDto; working: TaskDto["workingSession"]; selected: boolean; onOpen(row: HTMLElement | null): void; onOpenChat(sessionId: string): void;
}) {
  const waiting = taskWaiting(task);
  return (
    <li className="flex min-w-0 items-center gap-2 px-2 max-md:gap-3 max-md:px-4 max-md:py-0.5" data-chip-task={task.id} data-chip-task-selected={selected ? "" : undefined}>
      <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} name={task.statusName} size="md" className="shrink-0 pl-1 max-md:pl-0" />
      <button type="button" onClick={(e) => onOpen(e.currentTarget.closest("li"))} title={`Show #${task.number} ${task.title}`}
        data-chip-task-open="" aria-expanded={selected} aria-haspopup="dialog"
        className={cn(
          "flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left can-hover:hover:bg-surface-hover max-md:min-h-[26px] max-md:flex-col max-md:items-start max-md:justify-center max-md:gap-0.5",
          selected && "bg-accent-wash can-hover:hover:bg-accent-wash",
        )}>
        <span data-task-code-pair="" className="flex min-w-0 flex-1 items-baseline gap-1 max-md:w-full max-md:flex-none">
          <TaskCode task={task} viewProject={task.project} nested inRow className="text-[12px] max-md:text-[12.5px]" />
          <span data-task-code-title="" className="min-w-0 flex-1 truncate text-[13px] text-text max-md:text-sm">{task.title}</span>
        </span>
        <span className="flex min-w-0 shrink-0 items-center gap-2 text-[11.5px] text-text-3 max-md:max-w-full max-md:text-xs">
          {waiting ? <TaskWaitingLabel detail={waiting} className="max-w-[210px] max-md:max-w-full" />
            : <>
              <span className="max-w-[110px] truncate">{task.statusName}</span>
              {task.dueDate ? <TaskDueLabel dueDate={task.dueDate} className="text-[11.5px] max-md:text-xs" /> : <span aria-hidden>—</span>}
            </>}
        </span>
      </button>
      <TaskWorkingSessionChip working={working} check={task.check} onOpen={onOpenChat} className="shrink max-w-[40%]" />
    </li>
  );
}
