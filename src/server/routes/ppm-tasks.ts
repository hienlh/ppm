/**
 * `/api/tasks`: the task list ("what to do first", one project or all), one task with its children
 * and link states, and the plain writes (create, patch, close, reopen, reorder). Every write names
 * the revision it read; a stale one is a 409 carrying the current revision and changes nothing.
 * Decisions, chats, links, history and settings live in the two sibling routers.
 */
import { Hono } from "hono";
import { ok } from "../../types/api.ts";
import {
  closeTask, createTask, listTasks, reopenTask, reorderTask, setTaskDecision, taskChildren, updateTask,
} from "../../services/ppm-tasks/ppm-tasks.service.ts";
import { getDb } from "../../services/db.service.ts";
import { getTaskProject } from "../../services/ppm-tasks/ppm-tasks-projects.service.ts";
import { taskLinkStateSource } from "../../services/ppm-tasks/ppm-tasks-link-state-source.ts";
import { jiraSiteFor } from "../../services/ppm-tasks/link-state/ppm-tasks-jira-site.ts";
import { BASE_GROUPS, CLOSED_AS, type BaseGroup, type ClosedAs, type TaskFilter, type TaskPatch } from "../../shared/ppm-tasks.ts";
import type { TaskDetailResponse, TaskListResponse } from "../../shared/ppm-tasks-api.ts";
import { enabledProjectSummaries, projectSummary, toTaskDto, toTaskDtos } from "./ppm-tasks-dto.ts";
import {
  TASK_ID_PATTERN, USER_CTX, fail, failFrom, needsRevision, projectNotFound, readBody,
  registeredProjectNames, resolveTaskProject, revisionOf, taskOr404, tasksOff, writeAnswer,
} from "./ppm-tasks-route-helpers.ts";

export const ppmTasksRoutes = new Hono();

/** The fields a PATCH or create may carry; anything else in the body is ignored. */
const PATCH_KEYS = [
  "title", "type", "statusId", "urgency", "importance", "why", "nextStep", "notes", "dueDate", "tags",
  "assigneeMemberId", "waitingOnMemberId", "parentId", "workingSessionId", "fields", "links", "result",
  "snoozedUntil", "snoozeUntilChange",
] as const satisfies ReadonlyArray<keyof TaskPatch>;

function pickPatch(body: Record<string, unknown>): TaskPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) if (key in body) patch[key] = body[key];
  return patch as TaskPatch;
}

/** A decision as a body gives it, or undefined when it gives none. */
function decisionOf(body: Record<string, unknown>): { question?: string | null; options: string[] } | undefined {
  const d = body.decision;
  if (!d || typeof d !== "object" || Array.isArray(d)) return undefined;
  const { question, options } = d as { question?: unknown; options?: unknown };
  return { question: typeof question === "string" ? question : null, options: Array.isArray(options) ? options as string[] : [] };
}

const csv = (value: string | undefined): string[] | undefined => {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
};

/**
 * `?project=<name>|all&group=&type=&person=&tag=&q=&closed=0|1&snoozed=0|1&session=`. `group` and
 * `type` take a comma list; `closed=1` includes closed tasks, `snoozed=1` snoozed ones (each carries
 * `snoozed: true`, so the list can draw them apart); `session` only the tasks that chat works on.
 */
ppmTasksRoutes.get("/", (c) => {
  const q = c.req.query();
  const scope = q.project ?? "all";
  const registered = registeredProjectNames();
  let projects;
  if (scope === "all") {
    projects = enabledProjectSummaries(registered);
  } else {
    const project = resolveTaskProject(scope);
    if (!project) return projectNotFound(c, scope);
    if (!getTaskProject(project.key)?.enabled) return tasksOff(c, project.name);
    projects = [projectSummary(project.key, project.name)];
  }
  const groups = csv(q.group);
  if (groups?.some((g) => !BASE_GROUPS.includes(g as BaseGroup))) return fail(c, 400, "invalid", `group must be among ${BASE_GROUPS.join(", ")}`);
  const filter: TaskFilter = {
    projectKeys: projects.map((p) => p.projectKey),
    types: csv(q.type),
    baseGroups: groups as BaseGroup[] | undefined,
    memberId: q.person || undefined,
    tag: q.tag || undefined,
    text: q.q?.slice(0, 200) || undefined,
    includeClosed: q.closed === "1",
    snoozed: q.snoozed === "1" ? "include" : "exclude",
    workingSessionId: q.session?.trim() ? q.session.trim().slice(0, 200) : undefined,
  };
  return c.json(ok<TaskListResponse>({ tasks: toTaskDtos(listTasks(filter)), projects }));
});

ppmTasksRoutes.get(`/:id{${TASK_ID_PATTERN}}`, (c) => {
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  const detail: TaskDetailResponse = {
    task: toTaskDto(task),
    children: toTaskDtos(taskChildren(task.id)),
    linkStates: taskLinkStateSource().states(task.projectKey, task.links),
    jiraSite: jiraSiteFor(task.projectKey),
  };
  return c.json(ok(detail));
});

/** `{ project, title, …fields, decision? }`. */
ppmTasksRoutes.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return fail(c, 400, "invalid", "Send the task as a JSON object");
  const project = resolveTaskProject(typeof body.project === "string" ? body.project : null);
  if (!project) return projectNotFound(c, typeof body.project === "string" ? body.project : undefined);
  if (!getTaskProject(project.key)?.enabled) return tasksOff(c, project.name);
  try {
    const task = createTask({ ...pickPatch(body), projectKey: project.key, title: body.title as string, decision: decisionOf(body) }, USER_CTX);
    return writeAnswer(c, task);
  } catch (e) {
    return failFrom(c, e);
  }
});

/**
 * `{ revision, …fields, decision? }`. A body with both fields and a decision is written as two
 * changes, the decision second.
 */
ppmTasksRoutes.patch(`/:id{${TASK_ID_PATTERN}}`, async (c) => {
  const body = await readBody(c);
  if (!body) return fail(c, 400, "invalid", "Send the change as a JSON object");
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  try {
    const patch = pickPatch(body);
    const decision = decisionOf(body);
    let view = task;
    // One transaction: a refused decision undoes the field change before it (nothing half-written).
    getDb().transaction(() => {
      if (Object.keys(patch).length > 0 || !decision) view = updateTask(task.id, patch, revision, USER_CTX);
      if (decision) view = setTaskDecision(task.id, decision, view === task ? revision : view.revision, USER_CTX);
    })();
    return writeAnswer(c, view);
  } catch (e) {
    return failFrom(c, e);
  }
});

/** `{ revision, closedAs?: "done"|"dropped", statusId? }`. */
ppmTasksRoutes.post(`/:id{${TASK_ID_PATTERN}}/close`, async (c) => {
  const body = await readBody(c) ?? {};
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  if (body.closedAs !== undefined && !CLOSED_AS.includes(body.closedAs as ClosedAs)) return fail(c, 400, "invalid", "closedAs must be done or dropped");
  try {
    return writeAnswer(c, closeTask(c.req.param("id"), {
      closedAs: body.closedAs as ClosedAs | undefined,
      statusId: typeof body.statusId === "string" ? body.statusId : undefined,
    }, revision, USER_CTX));
  } catch (e) {
    return failFrom(c, e);
  }
});

/** `{ revision, statusId? }`. */
ppmTasksRoutes.post(`/:id{${TASK_ID_PATTERN}}/reopen`, async (c) => {
  const body = await readBody(c) ?? {};
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  try {
    return writeAnswer(c, reopenTask(c.req.param("id"), { statusId: typeof body.statusId === "string" ? body.statusId : undefined }, revision, USER_CTX));
  } catch (e) {
    return failFrom(c, e);
  }
});

/** `{ revision, beforeId? , afterId? }`: a neighbour in the task's own cell. */
ppmTasksRoutes.post(`/:id{${TASK_ID_PATTERN}}/reorder`, async (c) => {
  const body = await readBody(c) ?? {};
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  const to = {
    beforeId: typeof body.beforeId === "string" ? body.beforeId : undefined,
    afterId: typeof body.afterId === "string" ? body.afterId : undefined,
  };
  if (!to.beforeId && !to.afterId) return fail(c, 400, "invalid", "Name beforeId or afterId");
  try {
    return writeAnswer(c, reorderTask(c.req.param("id"), to, revision, USER_CTX));
  } catch (e) {
    return failFrom(c, e);
  }
});
