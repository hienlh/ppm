/**
 * One urgency group of the Tasks list ("Now 2"), its rows, and the line showing where a dragged
 * row would land. Empty groups still render their header while a drag is on, so a row can be
 * dropped into an urgency that has no tasks yet.
 */
import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import type { TaskListGroup as Group } from "@/lib/ppm-tasks/task-list-view";
import { TaskListRow, type TaskListRowProps } from "./task-list-row";
import type { DropTarget } from "./use-task-row-drag";

type RowShared = Omit<TaskListRowProps, "task" | "depth" | "selected" | "progress" | "members" | "linkStates" | "working" | "dragging">;

export interface TaskListGroupProps {
  group: Group;
  selectedId: string | null;
  draggingId: string | null;
  dropTarget: DropTarget | null;
  /** Per-row extras looked up by the list (members of the task's project, link states, progress). */
  rowExtras(task: Group["rows"][number]["task"]): Pick<TaskListRowProps, "progress" | "members" | "linkStates" | "working">;
  row: RowShared;
}

const DropLine = () => <div aria-hidden className="mx-2 h-0.5 rounded bg-accent" data-task-drop-line="" />;

export function TaskListGroup({ group, selectedId, draggingId, dropTarget, rowExtras, row }: TaskListGroupProps) {
  const dropHere = dropTarget?.urgency === group.urgency ? dropTarget.index : -1;
  if (group.rows.length === 0 && !draggingId) return null;
  let topIndex = 0;
  return (
    <section data-task-group={group.urgency} className={cn("pb-1", draggingId && "min-h-8")} aria-label={URGENCY_LABEL[group.urgency]}>
      <h3 className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">
        {URGENCY_LABEL[group.urgency]}
        <span className="rounded bg-surface px-1.5 font-mono text-[10.5px] font-normal">{group.count}</span>
        <span aria-hidden className="h-px flex-1 bg-border-soft" />
      </h3>
      {group.rows.map(({ task, depth }) => {
        const isDragged = task.id === draggingId;
        // The line sits before the top-level row at the drop index (the dragged row not counted).
        const lineBefore = depth === 0 && !isDragged && topIndex === dropHere;
        if (depth === 0 && !isDragged) topIndex++;
        return (
          <Fragment key={task.id}>
            {lineBefore && <DropLine />}
            <TaskListRow {...row} {...rowExtras(task)} task={task} depth={depth} selected={task.id === selectedId} dragging={isDragged} />
          </Fragment>
        );
      })}
      {dropHere >= 0 && dropHere >= topIndex && <DropLine />}
    </section>
  );
}
