/**
 * The task an AI-made schedule reminds about. `session_schedule_create` takes a `task` argument
 * (`ppm/12`, `#12`, `12` or a task id); it must name an open task of the project the schedule's
 * chat belongs to, so a chat cannot hang its schedule on another project's task.
 */
import { getDb } from "../db.service.ts";
import { ScheduleEditError } from "../scheduler-edit.ts";
import { getTask } from "../ppm-tasks/ppm-tasks-read.ts";
import { projectKey } from "../project-name-for-path.ts";
import { taskProjectName } from "./task-project-name.ts";
import { parseTaskRef } from "../../shared/ppm-tasks-refs.ts";

/**
 * The task the AI named for its schedule (`ppm/12`, `#12`, `12` or a task id), checked to belong
 * to the project of the chat the schedule goes into and to be open. Answers the task's id.
 */
export function resolveLinkableTask(ref: unknown, targetProjectPath: string): string {
  if (typeof ref !== "string" || !ref.trim()) throw new ScheduleEditError(["task must be a task reference such as ppm/12"]);
  const key = projectKey(targetProjectPath);
  const parsed = parseTaskRef(ref);
  let id: string | null = null;
  if (parsed) {
    const row = getDb().query("SELECT id FROM tasks WHERE project_key = ? AND number = ?").get(key, parsed.number) as { id: string } | null;
    id = row?.id ?? null;
    if (id && parsed.project && taskProjectName(key).toLowerCase() !== parsed.project.toLowerCase()) id = null;
  } else {
    id = ref.trim();
  }
  const task = id ? getTask(id) : null;
  if (!task || task.deletedAt !== null || task.projectKey !== key) {
    throw new ScheduleEditError([`No task ${ref.trim()} in this chat's project`]);
  }
  if (task.baseGroup === "closed") throw new ScheduleEditError([`Task ${ref.trim()} is closed: it needs no reminder`]);
  return task.id;
}
