/**
 * `/api/tasks` actions that reach past one row: recording a decision and having the server send it
 * to the chat doing the task (origin `ppm_ui`, no browser needed), starting a chat for a task,
 * telling the manager now, links, history with undo of AI changes, and live link states.
 */
import { Hono } from "hono";
import { ok } from "../../types/api.ts";
import { createProjectChatSession } from "../../services/chat-session-create.ts";
import { chatService } from "../../services/chat.service.ts";
import { deleteSessionMetadata, deleteSessionTitle, getSessionProjectPath, setSessionMetadata, setSessionTitle } from "../../services/db.service.ts";
import { projectNameForPath } from "../../services/project-name-for-path.ts";
import { decideTask, getTask, updateTask } from "../../services/ppm-tasks/ppm-tasks.service.ts";
import { deliverDecision, wakeManager } from "../../services/ppm-tasks/ppm-tasks-deliver.ts";
import { historyRow, taskHistory, undoChange, undoRefusal } from "../../services/ppm-tasks/ppm-tasks-history.ts";
import { getTaskProject } from "../../services/ppm-tasks/ppm-tasks-projects.service.ts";
import { taskLinkStateSource } from "../../services/ppm-tasks/ppm-tasks-link-state-source.ts";
import { managerSessionFor } from "../../services/ppm-tasks/ppm-tasks-write.ts";
import { workingSessionRefusal } from "../../services/ppm-tasks/ppm-tasks-session-check.ts";
import { LINK_KINDS, type LinkKind } from "../../shared/ppm-tasks.ts";
import type {
  NotifyManagerResponse, TaskDecideResponse, TaskHistoryFilter, TaskHistoryItem, TaskLinkStatesResponse, TaskStartChatResponse,
} from "../../shared/ppm-tasks-api.ts";
import { projectNameOfKey, toTaskDto, toTaskDtos } from "./ppm-tasks-dto.ts";
import {
  TASK_ID_PATTERN, USER_CTX, fail, failFrom, managerPromptFor, needsRevision, projectNotFound, readBody,
  resolveTaskProject, revisionOf, taskOr404, tasksOff, writeAnswer,
} from "./ppm-tasks-route-helpers.ts";

export const ppmTasksActionRoutes = new Hono();

/** The provider Start chat opens; tests swap in a scripted one. */
let startChatProvider = "claude";
export function setStartChatProvider(id: string | null): void {
  startChatProvider = id ?? "claude";
}

const ID = `:id{${TASK_ID_PATTERN}}`;

/**
 * `{ revision, optionId }`: records the choice, then the server sends it word for word to the
 * working chat (the manager when the task is not handed off). With no chat to send to, nothing is
 * recorded: 409 `no_session`, and the UI offers Start chat.
 */
ppmTasksActionRoutes.post(`/${ID}/decide`, async (c) => {
  const body = await readBody(c) ?? {};
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  if (typeof body.optionId !== "string" || !body.optionId) return fail(c, 400, "invalid", "optionId is required");
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  const target = task.workingSessionId ?? managerSessionFor(task.projectKey);
  // Asked before anything is recorded: a working chat that moved or a manager chat that was
  // deleted is no chat to send to, and a choice nobody receives must not be recorded.
  const refused = !target
    || (task.workingSessionId ? workingSessionRefusal(task.projectKey, task.workingSessionId) !== null : !getSessionProjectPath(target));
  if (refused) {
    return fail(c, 409, "no_session", "No chat works on this task and the project has no manager chat: start a chat first");
  }
  try {
    const decided = decideTask(task.id, body.optionId, revision, USER_CTX);
    const outcome = await deliverDecision(task.id, body.optionId);
    const after = getTask(task.id) ?? decided;
    // A choice that went to the manager itself needs no "tell the manager" afterwards.
    const toManager = outcome.ok && outcome.sessionId === managerSessionFor(task.projectKey);
    const answer: TaskDecideResponse = {
      task: toTaskDto(after),
      managerPrompt: !toManager && managerPromptFor(task.projectKey),
      delivered: outcome.ok ? outcome.delivered : null,
      sessionId: outcome.ok ? outcome.sessionId : target,
      ...(outcome.ok ? {} : { deliveryError: outcome.error ?? outcome.reason }),
    };
    return c.json(ok(answer));
  } catch (e) {
    return failFrom(c, e);
  }
});

/**
 * `{ revision }`: opens a new Claude chat titled after the task and makes it the task's working
 * session. Takes the task id only; the title comes from the stored row, never from the request.
 */
ppmTasksActionRoutes.post(`/${ID}/start-chat`, async (c) => {
  const body = await readBody(c) ?? {};
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  if (task.revision !== revision) return fail(c, 409, "stale", "The task changed since it was read", { revision: task.revision });
  // The project as PPM registers it at the task's folder: never another project of the same name.
  const storedPath = getTaskProject(task.projectKey)?.projectPath;
  const project = storedPath ? resolveTaskProject(projectNameForPath(storedPath)) : null;
  if (!project || project.key !== task.projectKey) return projectNotFound(c, projectNameOfKey(task.projectKey));
  const { name: projectName, path: projectPath } = project;
  let sessionId: string | null = null;
  try {
    const session = await createProjectChatSession({
      providerId: startChatProvider, projectName, projectPath, title: task.title.slice(0, 120), adoptWarmSpare: true,
    });
    sessionId = session.id;
    if (!getSessionProjectPath(session.id)) setSessionMetadata(session.id, projectName, projectPath);
    // Recorded now: a provider writes its own title only later, if at all, and the task's
    // working-session chip reads this one, so the new chat would otherwise show as "Chat".
    setSessionTitle(session.id, task.title.slice(0, 120));
    const view = updateTask(task.id, { workingSessionId: session.id }, revision, USER_CTX);
    const answer: TaskStartChatResponse = { task: toTaskDto(view), managerPrompt: managerPromptFor(task.projectKey), sessionId: session.id };
    return c.json(ok(answer));
  } catch (e) {
    // A chat the task does not point at would be an orphan nobody asked for.
    if (sessionId) {
      const orphan = sessionId;
      await chatService.deleteSession(startChatProvider, orphan).catch(() => {});
      // PPM's own records of it too (two Start chats at once: the loser's chat goes whole).
      try { deleteSessionTitle(orphan); deleteSessionMetadata(orphan); } catch { /* nothing more to drop */ }
    }
    return failFrom(c, e);
  }
});

/**
 * `{ project }`: the user said yes to "Tell the manager now?". One turn to the manager carrying
 * what changed, charged to the manager's send budget.
 */
ppmTasksActionRoutes.post("/notify-manager", async (c) => {
  const body = await readBody(c) ?? {};
  const name = typeof body.project === "string" ? body.project : undefined;
  const project = resolveTaskProject(name);
  if (!project) return projectNotFound(c, name);
  if (!getTaskProject(project.key)?.enabled) return tasksOff(c, project.name);
  const outcome = await wakeManager(project.key, USER_CTX.actor);
  let answer: NotifyManagerResponse;
  if (outcome.ok) answer = { sent: true, sessionId: outcome.sessionId };
  else if (outcome.reason === "no_session") answer = { sent: false, reason: "no_manager" };
  else if (outcome.reason === "nothing") answer = { sent: false, reason: "nothing_pending" };
  else if (outcome.reason === "budget") answer = { sent: false, reason: "budget", error: outcome.error };
  else answer = { sent: false, reason: "error", error: outcome.error ?? outcome.reason };
  return c.json(ok(answer));
});

/** `{ revision, kind, ref, label? }`: adds a link (a Jira key, a PR, a chat, a URL). */
ppmTasksActionRoutes.post(`/${ID}/links`, async (c) => {
  const body = await readBody(c) ?? {};
  const revision = revisionOf(body.revision);
  if (revision === null) return needsRevision(c);
  if (!LINK_KINDS.includes(body.kind as LinkKind)) return fail(c, 400, "invalid", `kind must be one of ${LINK_KINDS.join(", ")}`);
  if (typeof body.ref !== "string" || !body.ref.trim()) return fail(c, 400, "invalid", "ref is required");
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  const links = [
    ...task.links.map((l) => ({ kind: l.kind, ref: l.ref, label: l.label })),
    { kind: body.kind as LinkKind, ref: body.ref, label: typeof body.label === "string" ? body.label : null },
  ];
  try {
    return writeAnswer(c, updateTask(task.id, { links }, revision, USER_CTX));
  } catch (e) {
    return failFrom(c, e);
  }
});

/** `?revision=`; the link is named `<kind>:<ref>` (see `taskLinkId`). */
ppmTasksActionRoutes.delete(`/${ID}/links/:linkId`, (c) => {
  const revision = revisionOf(c.req.query("revision"));
  if (revision === null) return needsRevision(c);
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  const linkId = c.req.param("linkId");
  const links = task.links.filter((l) => `${l.kind}:${l.ref}` !== linkId);
  if (links.length === task.links.length) return fail(c, 404, "not_found", "No such link on this task");
  try {
    return writeAnswer(c, updateTask(task.id, { links: links.map((l) => ({ kind: l.kind, ref: l.ref, label: l.label })) }, revision, USER_CTX));
  } catch (e) {
    return failFrom(c, e);
  }
});

/** `?filter=all|ai|status`: newest first, each entry saying whether it can still be undone. */
ppmTasksActionRoutes.get(`/${ID}/history`, (c) => {
  const filter = (c.req.query("filter") ?? "all") as TaskHistoryFilter;
  if (!["all", "ai", "status"].includes(filter)) return fail(c, 400, "invalid", "filter must be all, ai or status");
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  const now = Date.now();
  const items: TaskHistoryItem[] = taskHistory(task.id, { aiOnly: filter === "ai", statusOnly: filter === "status" })
    .map((h) => ({ ...h, undoable: undoRefusal(h, now) === null }));
  return c.json(ok(items));
});

/** Undoes an AI change; 403 `forbidden` carries the reason when it cannot be undone. */
ppmTasksActionRoutes.post("/history/:historyId{[0-9]+}/undo", (c) => {
  const entry = historyRow(Number(c.req.param("historyId")));
  if (!entry) return fail(c, 404, "not_found", "History entry not found");
  try {
    undoChange(entry.id, USER_CTX);
    const task = entry.taskId ? getTask(entry.taskId) : null;
    if (!task) return fail(c, 404, "not_found", "Task not found");
    return writeAnswer(c, task);
  } catch (e) {
    return failFrom(c, e);
  }
});

/**
 * `?ids=a,b,c` (at most 100): cached link states and the working session of each task. A stale or
 * missing link state is refreshed in the background and pushed as `tasks:link_states`.
 */
ppmTasksActionRoutes.get("/link-states", (c) => {
  const ids = [...new Set((c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 100);
  const source = taskLinkStateSource();
  const tasks: TaskLinkStatesResponse["tasks"] = {};
  const views = ids.flatMap((id) => {
    const t = getTask(id);
    return t && t.deletedAt === null && getTaskProject(t.projectKey)?.enabled ? [t] : [];
  });
  toTaskDtos(views).forEach((dto, i) => {
    tasks[dto.id] = { linkStates: source.states(views[i]!.projectKey, views[i]!.links), workingSession: dto.workingSession };
  });
  return c.json(ok<TaskLinkStatesResponse>({ tasks }));
});
