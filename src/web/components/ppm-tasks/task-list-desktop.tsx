/**
 * The Tasks list on a desktop (variant-3 screen 01): the urgency groups, arrow keys that move the
 * selection with the main area following, and drag to reorder (or to change urgency by dropping
 * into another group).
 */
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { flatRows, planDrop, dropIsNoop } from "@/lib/ppm-tasks/task-list-view";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { TaskListGroup } from "./task-list-group";
import { useTaskListKeyboard } from "./use-task-list-keyboard";
import { useTaskRowDrag, type DropTarget } from "./use-task-row-drag";
import type { TaskListViewProps } from "./task-list-view-props";

export function TaskListDesktop(p: TaskListViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => flatRows(p.groups), [p.groups]);

  const onDrop = useCallback((task: TaskDto, target: DropTarget) => {
    const group = p.groups.find((g) => g.urgency === target.urgency);
    const groupRows = group?.rows.filter((r) => r.depth === 0).map((r) => r.task) ?? [];
    const plan = planDrop(task, target.urgency, groupRows, target.index);
    if (plan.kind === "none") { if (plan.reason) toast.info(plan.reason); return; }
    if (dropIsNoop(task, groupRows, plan)) return;
    p.onMove(task, plan.kind === "reorder" ? { reorder: plan.to } : { urgency: plan.urgency });
  }, [p]);

  const drag = useTaskRowDrag(ref, onDrop);
  const select = useCallback((task: TaskDto, keep: boolean) => {
    if (drag.swallowClick()) return;
    p.onSelect(task, keep);
  }, [drag, p]);
  const onKeyDown = useTaskListKeyboard(rows, p.selectedId, p.onSelect);

  const extras = useCallback((task: TaskDto) => {
    const live = p.live[task.id];
    return {
      progress: p.progress.get(task.id),
      members: p.settings[task.project]?.members,
      linkStates: live?.linkStates,
      working: live?.workingSession,
    };
  }, [p.live, p.progress, p.settings]);

  return (
    <div ref={ref} role="listbox" aria-label="Tasks" tabIndex={0} onKeyDown={onKeyDown} data-task-list=""
      className="px-1.5 pb-3 outline-none focus-visible:ring-1 focus-visible:ring-ring/40">
      {p.groups.map((g) => (
        <TaskListGroup key={g.urgency} group={g} selectedId={p.selectedId} draggingId={drag.dragging?.id ?? null} dropTarget={drag.target}
          rowExtras={extras}
          row={{ showProject: p.showProject, onSelect: select, onOpenChat: p.onOpenChat, onStartChat: p.onStartChat, onPointerDown: drag.onPointerDown }} />
      ))}
    </div>
  );
}
