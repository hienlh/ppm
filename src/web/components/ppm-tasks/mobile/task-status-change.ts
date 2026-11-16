/**
 * A status change from the phone views (the row's sheet, the detail's status button): a closed
 * status closes the task (Done or Dropped as the status says), leaving a closed status reopens it
 * on the one picked, anything else is a plain update. Same rules as the desktop's Status field.
 */
import type { TaskDto, TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import type { useTaskWrite } from "../use-task-write";

export type TaskStatusMove = "none" | "close" | "reopen" | "update";

/** Which write a move to `statusId` is. */
export function statusMove(task: Pick<TaskDto, "statusId" | "baseGroup">, statusId: string, statuses: TaskProjectSettings["statuses"] | undefined): TaskStatusMove {
  if (statusId === task.statusId) return "none";
  if (statuses?.find((s) => s.id === statusId)?.baseGroup === "closed") return "close";
  return task.baseGroup === "closed" ? "reopen" : "update";
}

export function changeTaskStatus(write: ReturnType<typeof useTaskWrite>, task: TaskDto, statusId: string, statuses: TaskProjectSettings["statuses"] | undefined): void {
  const { actions, run } = write;
  switch (statusMove(task, statusId, statuses)) {
    case "close": void run(task.id, () => actions.close(task, { statusId })); break;
    case "reopen": void run(task.id, () => actions.reopen(task, statusId)); break;
    case "update": void run(task.id, () => actions.update(task, { statusId })); break;
    default: break;
  }
}
