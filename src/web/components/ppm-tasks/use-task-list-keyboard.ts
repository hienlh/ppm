/**
 * Arrow keys in the Tasks list: ↑/↓ move the selection and the main area follows it (a preview
 * tab), Enter keeps the selected task's tab. Bound to the list element, so typing elsewhere is
 * never taken.
 */
import { useCallback, type KeyboardEvent } from "react";
import { stepSelection } from "@/lib/ppm-tasks/task-list-view";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export function useTaskListKeyboard(rows: readonly TaskDto[], selectedId: string | null, select: (task: TaskDto, keep: boolean) => void) {
  return useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const id = stepSelection(rows, selectedId, e.key === "ArrowDown" ? 1 : -1);
      const task = id ? rows.find((t) => t.id === id) : undefined;
      if (task) {
        select(task, false);
        // Keep the row in view as the selection walks past the edge.
        (e.currentTarget.querySelector(`[data-task-row="${CSS.escape(task.id)}"]`) as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter" && selectedId) {
      const task = rows.find((t) => t.id === selectedId);
      if (task) { e.preventDefault(); select(task, true); }
    }
  }, [rows, selectedId, select]);
}
