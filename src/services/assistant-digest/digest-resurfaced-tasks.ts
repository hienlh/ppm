/**
 * The morning digest's "Back from snooze today" section: tasks PPM brought back from a snooze on
 * the digest's day. The sweep runs first, so a task whose day came at midnight is listed even if
 * the minute timer has not reached it yet. Titles go out as the task store holds them; the card
 * and Telegram treat them as text.
 */
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import type { DigestResurfacedTask } from "../../shared/assistant-digest.ts";
import { listResurfacedOn } from "../ppm-tasks/ppm-tasks-read.ts";
import { resurfaceDueTasks } from "../ppm-tasks/ppm-tasks-snooze.ts";
import { projectNameOf } from "../ppm-tasks/tools/ppm-task-tool-format.ts";

export function digestResurfacedTasks(date: string, now: number = Date.now()): DigestResurfacedTask[] {
  resurfaceDueTasks(now);
  const names = new Map<string, string>();
  return listResurfacedOn(date).map((t) => {
    if (!names.has(t.projectKey)) names.set(t.projectKey, projectNameOf(t.projectKey));
    const project = names.get(t.projectKey)!;
    return { project, ref: formatTaskRef(t.number, project), title: t.title };
  });
}
