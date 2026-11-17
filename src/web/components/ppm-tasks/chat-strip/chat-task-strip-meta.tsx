/**
 * The labels after a task's title on a chat's task strip and in its "+N" list: the status (or, for
 * a waiting task, on whom it waits and until when), the due date and the snooze — the kit's own
 * labels, so they read as in every task list. Each gives way in turn as the chat narrows (the
 * status glyph before the title still says the status).
 */
import { taskWaiting } from "@/lib/ppm-tasks/task-format";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { TaskWaitingLabel } from "../kit/task-waiting-label";
import { TaskDueLabel } from "../kit/task-due-label";
import { TaskSnoozeBadge } from "../kit/task-snooze-badge";

export function ChatTaskStripMeta({ task }: { task: TaskDto }) {
  const waiting = taskWaiting(task);
  return (
    <span className="flex min-w-0 shrink items-center gap-2 text-[11.5px] text-text-3" data-chat-task-strip-meta="">
      {waiting
        ? <TaskWaitingLabel detail={waiting} className="max-w-[200px] @max-[420px]/chat:max-w-[120px]" />
        : <span data-chat-task-strip-status="" className="max-w-[120px] truncate @max-[420px]/chat:hidden">{task.statusName}</span>}
      {task.dueDate && !waiting && <TaskDueLabel dueDate={task.dueDate} className="shrink-0 @max-[340px]/chat:hidden" />}
      <TaskSnoozeBadge task={task} compact className="shrink-0 @max-[340px]/chat:hidden" />
    </span>
  );
}
