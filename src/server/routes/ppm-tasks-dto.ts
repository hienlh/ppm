/**
 * Tasks as `/api/tasks` sends them: the stored task decorated with its project's name, its ref
 * (`ppm/12`), its status name and who works on it right now (the working chat, else the manager,
 * else nobody), with the last check of a handed-off chat lifted out for rows that show one chip.
 */
import { basename } from "node:path";
import { projectNameForPath } from "../../services/project-name-for-path.ts";
import { memberRows, statusRows } from "../../services/ppm-tasks/ppm-tasks-db.ts";
import { getTaskProject, listTaskProjects } from "../../services/ppm-tasks/ppm-tasks-projects.service.ts";
import { listTasks } from "../../services/ppm-tasks/ppm-tasks.service.ts";
import { managerSessionFor } from "../../services/ppm-tasks/ppm-tasks-write.ts";
import { workingSessionFor } from "../../services/ppm-tasks/link-state/session-link-state-reader.ts";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { ME_MEMBER_ID, type TaskStatusDef, type TaskView } from "../../shared/ppm-tasks.ts";
import type { TaskDto, TaskProjectSummary, TaskWorkingSession } from "../../shared/ppm-tasks-api.ts";

/** The PPM name of a task project: the registered project at its folder, else the folder's name. */
export function projectNameOfKey(projectKey: string): string {
  const path = getTaskProject(projectKey)?.projectPath ?? projectKey;
  return projectNameForPath(path) ?? basename(path);
}

/** The working session of a task, and the check summary it carries. */
function workingOf(task: TaskView): { workingSession: TaskWorkingSession; check: TaskDto["check"] } {
  const workingSession = workingSessionFor(task) as TaskWorkingSession;
  const check = workingSession.kind === "session" ? workingSession.session.check ?? null : null;
  return { workingSession, check };
}

/** Decorates tasks for the wire. Status, member and project names are read once per project. */
export function toTaskDtos(views: TaskView[]): TaskDto[] {
  const names = new Map<string, string>();
  const statuses = new Map<string, Map<string, TaskStatusDef>>();
  const members = new Map<string, Map<string, string>>();
  return views.map((t) => {
    if (!names.has(t.projectKey)) {
      names.set(t.projectKey, projectNameOfKey(t.projectKey));
      statuses.set(t.projectKey, new Map(statusRows(t.projectKey).map((s) => [s.id, s])));
    }
    const project = names.get(t.projectKey)!;
    let waitingOnName: string | null = null;
    if (t.waitingOnMemberId && t.waitingOnMemberId !== ME_MEMBER_ID) {
      if (!members.has(t.projectKey)) members.set(t.projectKey, new Map(memberRows(t.projectKey).map((m) => [m.id, m.name])));
      waitingOnName = members.get(t.projectKey)!.get(t.waitingOnMemberId) ?? null;
    }
    return {
      ...t,
      project,
      ref: formatTaskRef(t.number, project),
      statusName: statuses.get(t.projectKey)!.get(t.statusId)?.name ?? "",
      waitingOnName,
      ...workingOf(t),
    };
  });
}

export const toTaskDto = (view: TaskView): TaskDto => toTaskDtos([view])[0]!;

/** A project with its open and Now counts. */
export function projectSummary(projectKey: string, name: string = projectNameOfKey(projectKey)): TaskProjectSummary {
  const project = getTaskProject(projectKey);
  const open = project?.enabled ? listTasks({ projectKeys: [projectKey] }) : [];
  return {
    name,
    projectKey,
    enabled: project?.enabled ?? false,
    hasManager: managerSessionFor(projectKey) !== null,
    open: open.length,
    now: open.filter((t) => t.effectiveUrgency === "now").length,
  };
}

/** Every switched-on project that is still registered in PPM, by name. */
export function enabledProjectSummaries(registered: ReadonlyMap<string, string>): TaskProjectSummary[] {
  return listTaskProjects({ enabledOnly: true })
    .flatMap((p) => {
      const name = registered.get(p.projectKey);
      return name ? [projectSummary(p.projectKey, name)] : [];
    });
}
