/**
 * A reminder belongs to its task: when the task is closed or deleted, its reminders are deleted
 * too, so nothing reminds the manager about work that is finished. Driven by the task store's
 * change events (every door: the page, the AI's task tools, Telegram), plus one sweep at start for
 * tasks closed while an older PPM, which knew nothing of this, was running.
 */
import { createLogger } from "../logger.ts";
import { getDb } from "../db.service.ts";
import { ppmTasksEvents } from "../ppm-tasks/ppm-tasks-events.ts";
import { getTask } from "../ppm-tasks/ppm-tasks-read.ts";
import { deleteSchedulesForTasks } from "../scheduler-db.service.ts";
import { announceSchedulesChanged } from "../session-schedules/session-schedules-changed.ts";

const log = createLogger("scheduler");

/** The tasks among `taskIds` that are closed, deleted or gone: their reminders have no purpose left. */
export function finishedTaskIds(taskIds: Iterable<string>): string[] {
  const finished: string[] = [];
  for (const id of new Set(taskIds)) {
    const task = getTask(id);
    if (!task || task.deletedAt !== null || task.baseGroup === "closed") finished.push(id);
  }
  return finished;
}

/**
 * Delete the reminders of every finished task among `taskIds`; answers how many went. Re-arms the
 * scheduler and refreshes open schedule lists when any did.
 */
export function dropRemindersOfFinishedTasks(taskIds: Iterable<string>, announce: () => void = announceSchedulesChanged): number {
  const finished = finishedTaskIds(taskIds);
  if (finished.length === 0) return 0;
  const deleted = deleteSchedulesForTasks(finished);
  if (deleted.length > 0) {
    log.info(`deleted ${deleted.length} reminder(s) of finished task(s): ${deleted.map((s) => `${s.id} (${s.name})`).join(", ")}`);
    announce();
  }
  return deleted.length;
}

/** Every task that owns a schedule. */
function tasksOwningSchedules(): string[] {
  return (getDb().query("SELECT DISTINCT task_id FROM schedules WHERE task_id IS NOT NULL").all() as Array<{ task_id: string }>).map((r) => r.task_id);
}

/** Starts listening; answers the function that stops it. */
export function startTaskReminderCleanup(): () => void {
  try {
    dropRemindersOfFinishedTasks(tasksOwningSchedules());
  } catch (e) {
    log.warn(`could not sweep reminders of finished tasks: ${(e as Error).message}`);
  }
  return ppmTasksEvents.on((e) => {
    if (e.type !== "task") return;
    // After the writer's listeners: the change is committed, and this writes.
    queueMicrotask(() => {
      try {
        dropRemindersOfFinishedTasks(e.taskIds);
      } catch (err) {
        log.warn(`could not delete reminders of finished tasks: ${(err as Error).message}`);
      }
    });
  });
}
