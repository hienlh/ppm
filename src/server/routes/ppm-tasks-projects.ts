/**
 * `/api/tasks/projects`: every registered project with its switch and counts, and one project's
 * task settings (the switch, the check interval, statuses, members, custom fields). These routes
 * answer for a switched-off project too: that is where it is switched back on. A settings write is
 * all or nothing.
 */
import { Hono } from "hono";
import { ok } from "../../types/api.ts";
import { configService } from "../../services/config.service.ts";
import { getDb } from "../../services/db.service.ts";
import { projectKey as keyOf } from "../../services/project-name-for-path.ts";
import { getTaskProject, setCheckInterval, setTasksEnabled } from "../../services/ppm-tasks/ppm-tasks-projects.service.ts";
import {
  addMember, addStatus, deleteFieldDef, deleteStatus, listFieldDefs, listMembers, listStatuses, updateMember, updateStatus,
  upsertFieldDef,
} from "../../services/ppm-tasks/ppm-tasks-project-config.ts";
import { CHECK_INTERVAL_DEFAULT_MIN } from "../../shared/ppm-tasks.ts";
import type { TaskProjectSettings, TaskProjectSettingsUpdate, TaskProjectSummary } from "../../shared/ppm-tasks-api.ts";
import { projectSummary } from "./ppm-tasks-dto.ts";
import { USER_CTX, fail, failFrom, projectNotFound, readBody, resolveTaskProject, type ResolvedProject } from "./ppm-tasks-route-helpers.ts";

export const ppmTasksProjectRoutes = new Hono();

function settingsOf(project: ResolvedProject): TaskProjectSettings {
  const stored = getTaskProject(project.key);
  return {
    project: {
      ...projectSummary(project.key, project.name),
      enabledBy: stored?.enabledBy ?? null,
      checkIntervalMin: stored?.checkIntervalMin ?? CHECK_INTERVAL_DEFAULT_MIN,
    },
    // A project never switched on has no row and no statuses yet.
    statuses: stored ? listStatuses(project.key) : [],
    members: stored ? listMembers(project.key, true) : [],
    fieldDefs: stored ? listFieldDefs(project.key) : [],
  };
}

/** Every registered project, switched on or not, in PPM's own order. */
ppmTasksProjectRoutes.get("/projects", (c) => {
  const projects: TaskProjectSummary[] = configService.get("projects").map((p) => projectSummary(keyOf(p.path), p.name));
  return c.json(ok(projects));
});

ppmTasksProjectRoutes.get("/projects/:name/settings", (c) => {
  const project = resolveTaskProject(c.req.param("name"));
  if (!project) return projectNotFound(c, c.req.param("name"));
  return c.json(ok(settingsOf(project)));
});

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

/** Applies one settings write in order; throws the store's error on the first part it refuses. */
function applySettings(project: ResolvedProject, u: TaskProjectSettingsUpdate): void {
  if (u.enabled !== undefined) {
    if (typeof u.enabled !== "boolean") throw new TypeError("enabled must be true or false");
    setTasksEnabled(project.path, u.enabled, USER_CTX);
  }
  if (u.checkIntervalMin !== undefined) setCheckInterval(project.key, u.checkIntervalMin, USER_CTX);
  const s = u.statuses ?? {};
  for (const add of list<NonNullable<typeof s.add>[number]>(s.add)) addStatus(project.key, add, USER_CTX);
  for (const { id, ...patch } of list<NonNullable<typeof s.update>[number]>(s.update)) {
    assertOwn("task_statuses", id, project.key);
    updateStatus(id, patch, USER_CTX);
  }
  for (const del of list<NonNullable<typeof s.delete>[number]>(s.delete)) {
    assertOwn("task_statuses", del.id, project.key);
    deleteStatus(del.id, del.replacementId ?? null, USER_CTX);
  }
  const m = u.members ?? {};
  for (const add of list<NonNullable<typeof m.add>[number]>(m.add)) addMember(project.key, add, USER_CTX);
  for (const { id, ...patch } of list<NonNullable<typeof m.update>[number]>(m.update)) {
    assertOwn("task_members", id, project.key);
    updateMember(id, patch, USER_CTX);
  }
  const f = u.fields ?? {};
  for (const def of list<NonNullable<typeof f.upsert>[number]>(f.upsert)) upsertFieldDef(project.key, def, USER_CTX);
  for (const key of list<string>(f.delete)) deleteFieldDef(project.key, key, USER_CTX);
}

/** A status or member named by id must be this project's: the URL names the project. */
function assertOwn(table: "task_statuses" | "task_members", id: unknown, projectKey: string): void {
  const row = typeof id === "string"
    ? getDb().query(`SELECT project_key FROM ${table} WHERE id = ?`).get(id) as { project_key: string } | null : null;
  if (row?.project_key !== projectKey) throw new OwnershipError(table === "task_statuses" ? "No such status in this project" : "No such member in this project");
}

class OwnershipError extends Error {}

/** A `TaskProjectSettingsUpdate`; answers the settings as they now stand. */
ppmTasksProjectRoutes.put("/projects/:name/settings", async (c) => {
  const project = resolveTaskProject(c.req.param("name"));
  if (!project) return projectNotFound(c, c.req.param("name"));
  const body = await readBody(c);
  if (!body) return fail(c, 400, "invalid", "Send the settings as a JSON object");
  const enabled = getTaskProject(project.key)?.enabled ?? false;
  if (!enabled && body.enabled !== true && Object.keys(body).some((k) => k !== "enabled")) {
    return fail(c, 404, "tasks_off", `Tasks are switched off for ${project.name}: switch them on first`);
  }
  try {
    // One transaction: a refused part undoes the parts before it. Events already sent for those
    // parts only make a list re-read what did not change.
    getDb().transaction(() => applySettings(project, body as TaskProjectSettingsUpdate))();
  } catch (e) {
    if (e instanceof OwnershipError) return fail(c, 404, "not_found", e.message);
    if (e instanceof TypeError) return fail(c, 400, "invalid", e.message);
    return failFrom(c, e);
  }
  return c.json(ok(settingsOf(project)));
});
