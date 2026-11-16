/**
 * Finding a task by the code the chats use (`#82`, `ppm/82`), for the task list's search box and
 * the command palette. `#82` means task 82 of the project in view when there is one; with none
 * (the all-projects scope, a palette opened outside a project) it means every project's task 82.
 */
import { matchesTaskCode, parseTaskCodeQuery, type ParsedTaskRef } from "../../../shared/ppm-tasks-refs";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { ppmTasksClient } from "./ppm-tasks-client";

/**
 * The tasks a code names. A bare `#82` typed with a project in view is that project's task 82;
 * `anywhere` lets it fall back to other projects' task 82 when the project has none (the palette,
 * which lists each match with its project). With no project in view it is every project's #82.
 * Deleted tasks are never a match.
 */
export function tasksMatchingCode(tasks: readonly TaskDto[], code: ParsedTaskRef, contextProject: string | null, opts: { anywhere?: boolean } = {}): TaskDto[] {
  const all = tasks.filter((t) => t.deletedAt === null && matchesTaskCode(t, code));
  if (code.project !== null || contextProject === null) return all;
  const own = all.filter((t) => t.project === contextProject);
  return own.length || !opts.anywhere ? own : all;
}

/**
 * The tasks a search text names, asked from the server: null when the text is not a code (search
 * titles instead), else the matches (empty when no task has that code, or the request failed).
 */
export async function lookupTasksByCode(query: string, contextProject: string | null, opts: { anywhere?: boolean } = {}): Promise<TaskDto[] | null> {
  const code = parseTaskCodeQuery(query);
  if (!code) return null;
  try {
    // Every switched-on project in one request: a task list is small, and the project in the
    // code may be spelled in another case than its name.
    const { tasks } = await ppmTasksClient.list({ project: "all", closed: true });
    return tasksMatchingCode(tasks, code, contextProject, opts);
  } catch {
    return [];
  }
}
