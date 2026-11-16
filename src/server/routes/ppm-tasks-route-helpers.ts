/**
 * What the three `/api/tasks` routers share: naming a project, reading a body, answering an error
 * with a machine-readable `code`, and the write context of a request (always the user, via PPM:
 * these routes sit behind PPM's auth and no AI reaches them).
 */
import type { Context } from "hono";
import { configService } from "../../services/config.service.ts";
import { projectKey as keyOf } from "../../services/project-name-for-path.ts";
import { PpmTaskError, TaskConflictError } from "../../services/ppm-tasks/ppm-tasks-errors.ts";
import { getTaskProject } from "../../services/ppm-tasks/ppm-tasks-projects.service.ts";
import { getTask } from "../../services/ppm-tasks/ppm-tasks.service.ts";
import { managerSessionFor } from "../../services/ppm-tasks/ppm-tasks-write.ts";
import { createLogger } from "../../services/logger.ts";
import { ok } from "../../types/api.ts";
import type { TaskView, WriteContext } from "../../shared/ppm-tasks.ts";
import type { TaskApiErrorCode, TaskWriteResponse } from "../../shared/ppm-tasks-api.ts";
import { toTaskDto } from "./ppm-tasks-dto.ts";

const log = createLogger("ppm-tasks-api");

/** Every REST write is the user's own, made in PPM. */
export const USER_CTX: WriteContext = { actor: { kind: "user", label: "You" }, via: "ppm" };

/**
 * A task id (the store mints UUIDs). Hex and dashes only, so no literal sibling path
 * (`projects`, `link-states`, `notify-manager`, `history`) can be taken for an id. No `{n}`
 * quantifier: the route-table probe in the design-share test reads a parameter's pattern up to
 * its first `}`.
 */
export const TASK_ID_PATTERN = "[0-9a-fA-F-]+";

export interface ResolvedProject {
  name: string;
  path: string;
  key: string;
}

/** A registered PPM project by its exact name; null for anything else (paths are not accepted). */
export function resolveTaskProject(name: string | undefined | null): ResolvedProject | null {
  if (!name) return null;
  const project = configService.get("projects").find((p) => p.name === name);
  return project ? { name: project.name, path: project.path, key: keyOf(project.path) } : null;
}

/** Registered projects by stored key → name. */
export function registeredProjectNames(): Map<string, string> {
  return new Map(configService.get("projects").map((p) => [keyOf(p.path), p.name]));
}

/** The JSON object a request sent, or null (a malformed body is a 400, never a 500). */
export async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

export function fail(c: Context, status: 400 | 403 | 404 | 409 | 500, code: TaskApiErrorCode, error: string, extra: Record<string, unknown> = {}): Response {
  return c.json({ ok: false, error, code, ...extra }, status);
}

/** Maps the store's errors; anything else is logged and answered 500. */
export function failFrom(c: Context, e: unknown): Response {
  if (e instanceof TaskConflictError) return fail(c, 409, "stale", e.message, { revision: e.currentRevision });
  if (e instanceof PpmTaskError) {
    switch (e.code) {
      case "not_found": return fail(c, 404, "not_found", e.message);
      case "disabled": return fail(c, 404, "tasks_off", e.message);
      case "invalid": return fail(c, 400, "invalid", e.message);
      case "forbidden": return fail(c, 403, "forbidden", e.message);
      case "conflict": return fail(c, 409, "stale", e.message);
    }
  }
  log.warn(`task request failed: ${(e as Error)?.message ?? String(e)}`);
  return c.json({ ok: false, error: (e as Error)?.message ?? "Task request failed" }, 500);
}

export const projectNotFound = (c: Context, name: string | undefined): Response =>
  fail(c, 404, "project_not_found", name ? `No PPM project named ${name}` : "Name a project");

export const tasksOff = (c: Context, name: string): Response =>
  fail(c, 404, "tasks_off", `Tasks are switched off for ${name}`);

/** The task a route acts on, or the response saying why there is none. */
export function taskOr404(c: Context, id: string): TaskView | Response {
  const task = getTask(id);
  if (!task || task.deletedAt !== null) return fail(c, 404, "not_found", "Task not found");
  if (!getTaskProject(task.projectKey)?.enabled) return fail(c, 404, "tasks_off", "Tasks are switched off for this project");
  return task;
}

/** A `revision` from a body or query: a non-negative whole number, else null. */
export function revisionOf(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export const needsRevision = (c: Context): Response => fail(c, 400, "invalid", "revision is required: the task's revision as last read");

/** Whether to ask the user "Tell the manager now?" after their change: only when there is one. */
export const managerPromptFor = (projectKey: string): boolean => managerSessionFor(projectKey) !== null;

/** A write's answer: the task as it now stands, and whether to ask about telling the manager. */
export const writeAnswer = (c: Context, task: TaskView): Response =>
  c.json(ok<TaskWriteResponse>({ task: toTaskDto(task), managerPrompt: managerPromptFor(task.projectKey) }));
