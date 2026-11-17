/**
 * A chat working on a task asks for it to be closed. Only a manager chat, the PPM Assistant or the
 * user closes a task, so a working chat cannot switch off the checks the manager relies on; this
 * records its request instead. The request changes no field and no revision: it is one history row
 * (`close_proposed`), which reaches the manager as a line of its PPM Tasks news like any other
 * change by someone else. The manager checks the work and closes the task itself.
 */
import { getDb } from "../db.service.ts";
import { CLOSED_AS, type ClosedAs, type TaskView, type WriteContext } from "../../shared/ppm-tasks.ts";
import { loadTask, statusById } from "./ppm-tasks-db.ts";
import { PpmTaskError, TaskConflictError, invalid, notFound } from "./ppm-tasks-errors.ts";
import { writeHistory } from "./ppm-tasks-history.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";
import { getTaskProject } from "./ppm-tasks-projects.service.ts";
import { getTask } from "./ppm-tasks-read.ts";
import { checkContext } from "./ppm-tasks-validate.ts";

/** The one change a proposal row carries. */
export const CLOSE_PROPOSAL_FIELD = "closeProposal";

/**
 * Records that `ctx`'s chat proposes closing the task as `closedAs`. Checks the revision the chat
 * read (it proposes on what it saw) and that the task is still open. Returns the task as it is and
 * the history row's id.
 */
export function proposeClose(
  taskId: string, closedAs: ClosedAs, expectedRevision: number, ctx: WriteContext, now: number = Date.now(),
): { task: TaskView; historyId: number } {
  checkContext(ctx);
  if (!CLOSED_AS.includes(closedAs)) throw invalid(`propose_close must be one of ${CLOSED_AS.join(", ")}`);
  let historyId = 0;
  let projectKey = "";
  getDb().transaction(() => {
    const task = loadTask(taskId);
    if (!task || task.deletedAt !== null) throw notFound("Task");
    const project = getTaskProject(task.projectKey);
    if (!project?.enabled) throw new PpmTaskError("disabled", "Tasks are switched off for this project");
    if (task.revision !== expectedRevision) throw new TaskConflictError(task.id, task.revision);
    if (statusById(task.statusId)?.baseGroup === "closed") throw invalid("The task is already closed");
    projectKey = task.projectKey;
    historyId = writeHistory({
      taskId: task.id, projectKey, ctx, kind: "close_proposed", at: now,
      changes: [{ field: CLOSE_PROPOSAL_FIELD, before: null, after: closedAs }],
    });
  })();
  ppmTasksEvents.emit({
    type: "task", projectKey, taskIds: [taskId], historyIds: [historyId], actor: ctx.actor, via: ctx.via, kind: "close_proposed", unattended: !!ctx.unattended,
  });
  return { task: getTask(taskId)!, historyId };
}
