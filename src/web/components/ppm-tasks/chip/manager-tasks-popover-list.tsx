/**
 * The compact "what to do first" list the manager chat's Tasks chip opens (variant-3 screen 00):
 * the project's open tasks grouped by urgency, each row its status glyph, title, status, due date
 * and working-session chip, at most `CHIP_LIST_LIMIT` rows with "<m> more" and "Show in sidebar"
 * at the foot. One line per row in the desktop popover, two lines (60px) in the phone's sheet.
 *
 * A row opens the task: its tab in the main area — full screen on a phone — with the Tasks
 * section of the sidebar made current and the task selected in it, so the list is one tap away.
 */
import { useMemo } from "react";
import { ListTodo, PanelRight } from "@/lib/icons";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { usePpmTaskLinkStates, usePpmTaskList } from "@/hooks/use-ppm-tasks";
import { URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { groupTasks } from "@/lib/ppm-tasks/task-list-view";
import { openTaskChat, openTaskTab, workingProvider } from "@/lib/ppm-tasks/open-task-tab";
import { revealTaskInSidebar } from "@/lib/ppm-tasks/reveal-task-in-sidebar";
import type { Urgency } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { FooterButton, FooterPopoverFooter, FooterPopoverHeader } from "@/components/chat/footer-popover";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskDueLabel } from "../kit/task-due-label";
import { TaskWorkingSessionChip } from "../kit/task-working-session-chip";

export const CHIP_LIST_LIMIT = 8;

export interface ChipListView {
  groups: Array<{ urgency: Urgency; tasks: TaskDto[] }>;
  /** Open top-level tasks left out by the limit. */
  more: number;
  ids: string[];
}

/** The rows the chip shows: open top-level tasks in "what to do first" order, cut at `limit`. */
export function chipListView(tasks: readonly TaskDto[], limit = CHIP_LIST_LIMIT): ChipListView {
  const open = tasks.filter((t) => t.baseGroup !== "closed" && t.deletedAt === null);
  const groups: ChipListView["groups"] = [];
  let shown = 0;
  let total = 0;
  for (const g of groupTasks(open, new Set())) {
    const top = g.rows.filter((r) => r.depth === 0).map((r) => r.task);
    total += top.length;
    const take = top.slice(0, Math.max(0, limit - shown));
    shown += take.length;
    if (take.length) groups.push({ urgency: g.urgency, tasks: take });
  }
  return { groups, more: total - shown, ids: groups.flatMap((g) => g.tasks.map((t) => t.id)) };
}

export function ManagerTasksPopoverList({ project, total, onClose }: { project: string; total: number; onClose(): void }) {
  const { tasks, loading, error } = usePpmTaskList({ project, closed: false });
  const view = useMemo(() => chipListView(tasks), [tasks]);
  // The chip counts child tasks too; whatever the list leaves out is "more" in the sidebar.
  const more = Math.max(view.more, total - view.ids.length);
  const live = usePpmTaskLinkStates(view.ids, project);

  const openTask = (task: TaskDto) => {
    onClose();
    // A phone pushes into the task; its back button then lands on this list, already selected.
    revealTaskInSidebar(task, { openList: !isMobileDevice() });
    openTaskTab(task);
  };
  const showInSidebar = () => { onClose(); revealTaskInSidebar({ project }, { openList: true }); };

  return (
    <>
      <FooterPopoverHeader>
        <ListTodo aria-hidden className="size-3.5 shrink-0 text-primary" />
        <b className="text-[13px] font-semibold max-md:text-sm">Tasks</b>
        <span className="rounded bg-surface px-1.5 font-mono text-[11px] text-text-3">{total}</span>
        <span className="min-w-0 truncate text-text-3 max-md:text-xs">{project} · what to do first</span>
      </FooterPopoverHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" data-manager-tasks-list="">
        {error ? <p className="px-3 py-3 text-error">{error}</p>
          : loading && tasks.length === 0 ? <p className="px-3 py-3 text-text-3">Loading tasks…</p>
          : view.groups.length === 0 ? <p className="px-3 py-3 text-text-3 max-md:px-4">No open tasks</p>
          : view.groups.map((g) => (
            <section key={g.urgency} aria-label={URGENCY_LABEL[g.urgency]}>
              <h4 className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-3 max-md:px-4">{URGENCY_LABEL[g.urgency]}</h4>
              <ul>
                {g.tasks.map((t) => (
                  <ChipRow key={t.id} task={t} working={live[t.id]?.workingSession ?? t.workingSession}
                    onOpen={() => openTask(t)}
                    onOpenChat={(sid) => { onClose(); openTaskChat(t.project, sid, workingProvider(live[t.id] ? { workingSession: live[t.id]!.workingSession } : t), t); }} />
                ))}
              </ul>
            </section>
          ))}
      </div>
      <FooterPopoverFooter>
        <span className="min-w-0 truncate px-1 text-text-3 max-md:text-xs">
          {more > 0 ? `${more} more` : ""}
          <span className="md:hidden">{more > 0 ? " · " : ""}tap a task to open it</span>
        </span>
        <FooterButton className="ml-auto" onClick={showInSidebar}><PanelRight />Show in sidebar</FooterButton>
      </FooterPopoverFooter>
    </>
  );
}

function ChipRow({ task, working, onOpen, onOpenChat }: {
  task: TaskDto; working: TaskDto["workingSession"]; onOpen(): void; onOpenChat(sessionId: string): void;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 px-2 max-md:min-h-[60px] max-md:gap-3 max-md:px-4" data-chip-task={task.id}>
      <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} name={task.statusName} size="md" className="shrink-0 pl-1 max-md:pl-0" />
      <button type="button" onClick={onOpen} title={`Open ${task.title}`}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left can-hover:hover:bg-surface-hover max-md:min-h-11 max-md:flex-col max-md:items-start max-md:justify-center max-md:gap-0.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-text max-md:w-full max-md:flex-none max-md:text-sm">{task.title}</span>
        <span className="flex min-w-0 shrink-0 items-center gap-2 text-[11.5px] text-text-3 max-md:max-w-full max-md:text-xs">
          <span className="max-w-[110px] truncate">{task.statusName}</span>
          {task.dueDate ? <TaskDueLabel dueDate={task.dueDate} className="text-[11.5px] max-md:text-xs" /> : <span aria-hidden>—</span>}
        </span>
      </button>
      <TaskWorkingSessionChip working={working} check={task.check} onOpen={onOpenChat} className="shrink max-w-[40%]" />
    </li>
  );
}
