/**
 * The server half of a task reference on a user message (`src/shared/chat-task-ref.ts`): a browser
 * or the Telegram bridge names task ids, and this reads each task from the store, checks the chat
 * may talk about it, and builds the reference from what the store says now. Nothing a caller sends
 * reaches the block except the id.
 *
 * A chat may reference a task of its own project. A PPM Assistant session may reference any task,
 * as its task tools may. A deleted task, or one in a project with Tasks switched off, is refused,
 * as is a task of another project: the message is not sent, so the user is never left believing
 * the AI was told which task they meant when it was not.
 *
 * The title is user and AI text: PPM-looking tags are defused and line breaks folded before it is
 * written, and the codec also writes it as an escaped JSON string.
 */
import { basename } from "node:path";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { MAX_TASK_REFS, validateTaskRef, type TaskReference } from "../../shared/chat-task-ref.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import { notificationLink } from "../notification-link.ts";
import { tunnelService } from "../tunnel.service.ts";
import { ppmPublicPort } from "../tailscale/tailscale-app-service.ts";
import { projectKey, projectNameForPath } from "../project-name-for-path.ts";
import { listStatuses } from "./ppm-tasks-project-config.ts";
import { getTaskProject } from "./ppm-tasks-projects.service.ts";
import { getTask } from "./ppm-tasks.service.ts";

const TITLE_MAX = 300;
/** How long the link's base is reused: working it out asks the Tailscale CLI three things. */
const LINK_BASE_TTL_MS = 5 * 60_000;

let linkBase: { at: number; base: string } | null = null;
let refreshing = false;

/**
 * PPM's address for a link the AI can hand on, without ever waiting: a message is not held up
 * (and cannot be overtaken by the next one) while it is worked out. The last address found is
 * used, refreshed in the background every few minutes in `notificationLink`'s order (the tunnel,
 * else the Tailscale Service, else localhost); before the first answer, the tunnel or localhost.
 */
function ppmLinkBase(now = Date.now()): string {
  if ((!linkBase || now - linkBase.at > LINK_BASE_TTL_MS) && !refreshing) {
    refreshing = true;
    void notificationLink({ project: "", sessionId: "", path: "/" })
      .then((url) => { linkBase = { at: Date.now(), base: url.replace(/\/+$/, "") }; })
      .catch(() => {})
      .finally(() => { refreshing = false; });
  }
  return linkBase?.base ?? (tunnelService.getTunnelUrl() ?? `http://localhost:${ppmPublicPort()}`).replace(/\/+$/, "");
}

/** Forgets the cached base (tests). */
export function resetTaskLinkBase(): void {
  linkBase = null;
  refreshing = false;
}

/** Which tasks a chat may reference: those of the project at `projectPath`, or any (the Assistant). */
export type TaskRefScope = { anyProject: true } | { anyProject: false; projectPath: string | null | undefined };

export type TaskRefResolution = { ok: true; refs: TaskReference[] } | { ok: false; error: string };

/** The PPM name of a task project: the registered project at its folder, else the folder's name. */
function projectNameOf(key: string): string {
  const path = getTaskProject(key)?.projectPath ?? key;
  return projectNameForPath(path) ?? basename(path);
}

/** One line of text, PPM tags defused, at most `max` characters; `fallback` when nothing is left. */
function oneLine(text: string, max: number, fallback: string): string {
  // `\s` takes in the Unicode line and paragraph separators too.
  const line = neutralizePpmTags(text).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const clipped = Array.from(line).slice(0, max).join("").trim();
  return clipped || fallback;
}

/** The reference for one task as the store has it now, or why it cannot be one. */
export async function resolveTaskRef(taskId: string, scope: TaskRefScope): Promise<{ ok: true; ref: TaskReference } | { ok: false; error: string }> {
  const task = getTask(taskId);
  if (!task || task.deletedAt !== null) return { ok: false, error: "That task no longer exists" };
  if (!getTaskProject(task.projectKey)?.enabled) return { ok: false, error: "Tasks are switched off for that task's project" };
  if (!scope.anyProject && (!scope.projectPath || projectKey(scope.projectPath) !== task.projectKey)) {
    return { ok: false, error: "That task belongs to another project than this chat" };
  }
  const projectName = projectNameOf(task.projectKey);
  const status = listStatuses(task.projectKey).find((s) => s.id === task.statusId)?.name ?? "Unknown status";
  const link = `${ppmLinkBase()}/project/${encodeURIComponent(projectName)}/task/${task.id}`;
  const ref = validateTaskRef({
    version: 1, taskId: task.id, ref: oneLine(formatTaskRef(task.number, projectName), 212, `#${task.number}`), number: task.number,
    projectName: oneLine(projectName, 200, "project"), title: oneLine(task.title, TITLE_MAX, "(untitled)"),
    status: oneLine(status, 80, "Unknown status"), urgency: task.effectiveUrgency, due: task.dueDate, link,
  });
  return ref ? { ok: true, ref } : { ok: false, error: "That task cannot be referenced" };
}

/** The references for `taskIds`, in order; the first refusal wins. */
export async function resolveTaskRefs(taskIds: readonly string[], scope: TaskRefScope): Promise<TaskRefResolution> {
  if (taskIds.length > MAX_TASK_REFS) return { ok: false, error: `A message can be about at most ${MAX_TASK_REFS} tasks` };
  const refs: TaskReference[] = [];
  for (const id of taskIds) {
    const one = await resolveTaskRef(id, scope);
    if (!one.ok) return one;
    refs.push(one.ref);
  }
  return { ok: true, refs };
}
