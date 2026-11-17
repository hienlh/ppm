/**
 * The Tasks list on a phone (variant-3 screen 03), inside the navigation drawer's Tasks section:
 * the same Now / Today / This week / Later groups as the desktop list, as 62px rows. A tap opens
 * the task full screen; a long-press (or a tap on the status cell) opens the row's sheet — the
 * project's statuses, urgency, Reorder… within the task's cell, Ask manager, Copy link. Writes
 * go through `useTaskWrite`, so a change still offers "Tell the manager now?".
 */
import { useCallback, useMemo, useState } from "react";
import { useManagerChats } from "@/hooks/use-manager-chats";
import { URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { askManagerAboutTask, managerOf } from "@/lib/ppm-tasks/ask-manager-about-task";
import type { TaskListGroup } from "@/lib/ppm-tasks/task-list-view";
import { cellKey } from "../../../../shared/ppm-tasks-order";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import type { TaskListViewProps } from "../task-list-view-props";
import { useTaskWrite } from "../use-task-write";
import { TaskRowMobile } from "./task-row-mobile";
import { TaskRowActionSheet } from "./task-row-action-sheet";
import { changeTaskStatus } from "./task-status-change";
import { TaskSnoozedSection } from "../task-snoozed-section";
import { UNSNOOZE_PATCH } from "@/lib/ppm-tasks/task-snooze-choices";

/** The rows above and below `task` in its own cell, in list order: where Reorder can move it. */
export function cellNeighbours(groups: readonly TaskListGroup[], task: TaskDto | null): { up: TaskDto | null; down: TaskDto | null } {
  if (!task) return { up: null, down: null };
  const group = groups.find((g) => g.urgency === task.effectiveUrgency);
  const cell = (group?.rows ?? []).filter((r) => r.depth === 0 && cellKey(r.task) === cellKey(task)).map((r) => r.task);
  const at = cell.findIndex((t) => t.id === task.id);
  return at < 0 ? { up: null, down: null } : { up: cell[at - 1] ?? null, down: cell[at + 1] ?? null };
}

export function TaskListMobile(p: TaskListViewProps) {
  const [pressedId, setPressedId] = useState<string | null>(null);
  const write = useTaskWrite();
  const managers = useManagerChats();
  const pressed = useMemo(() => {
    for (const g of p.groups) for (const r of g.rows) if (r.task.id === pressedId) return r.task;
    return p.snoozed.find((t) => t.id === pressedId) ?? null;
  }, [p.groups, p.snoozed, pressedId]);

  const open = useCallback((task: TaskDto) => p.onSelect(task, true), [p]);
  const actions = useCallback((task: TaskDto) => setPressedId(task.id), []);

  return (
    <div aria-label="Tasks" data-task-list="" data-task-list-mobile="" className="pb-4">
      {p.groups.filter((g) => g.rows.length > 0).map((g) => (
        <section key={g.urgency} data-task-group={g.urgency} aria-label={URGENCY_LABEL[g.urgency]}>
          <h3 className="flex items-center gap-2 bg-panel px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-text-3">
            {URGENCY_LABEL[g.urgency]}<span className="rounded bg-surface px-1.5 font-mono text-[11px] font-normal">{g.count}</span>
          </h3>
          <div className="divide-y divide-border-soft">
            {g.rows.map(({ task, depth }) => {
              const live = p.live[task.id];
              return (
                <div key={task.id}>
                  <TaskRowMobile task={task} depth={depth} selected={task.id === p.selectedId} showProject={p.showProject}
                    progress={p.progress.get(task.id)} members={p.settings[task.project]?.members}
                    linkStates={live?.linkStates} working={live?.workingSession}
                    onOpen={open} onActions={actions} onOpenChat={p.onOpenChat} onStartChat={p.onStartChat} />
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <TaskSnoozedSection tasks={p.snoozed} mobile row={(task) => {
        const live = p.live[task.id];
        return (
          <TaskRowMobile task={task} depth={0} selected={task.id === p.selectedId} showProject={p.showProject}
            progress={p.progress.get(task.id)} members={p.settings[task.project]?.members}
            linkStates={live?.linkStates} working={live?.workingSession}
            onOpen={open} onActions={actions} onOpenChat={p.onOpenChat} onStartChat={p.onStartChat}
            onUnsnooze={(t) => p.onSnooze(t, UNSNOOZE_PATCH)} />
        );
      }} />
      <TaskRowActionSheet task={pressed} showProject={p.showProject} statuses={pressed ? p.settings[pressed.project]?.statuses : undefined}
        neighbours={cellNeighbours(p.groups, pressed)} hasManager={!!(pressed && managerOf(pressed.project, managers))}
        onClose={() => setPressedId(null)}
        onStatus={(t, id) => changeTaskStatus(write, t, id, p.settings[t.project]?.statuses)}
        onUrgency={(t, urgency) => p.onMove(t, { urgency })}
        onReorder={(t, to) => p.onMove(t, { reorder: to })}
        onAskManager={(t) => void askManagerAboutTask(t, managers)}
        onSnooze={p.onSnooze} />
    </div>
  );
}
