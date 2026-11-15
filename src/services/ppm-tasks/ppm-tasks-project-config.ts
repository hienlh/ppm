/**
 * A project's statuses, members and custom field definitions. Every project always keeps at least
 * one not-started and one closed status; a status in use is deleted only with a replacement, and
 * its tasks move to it with a history row each.
 */
import { getDb } from "../db.service.ts";
import {
  BASE_GROUPS, CLOSED_AS, FIELD_TYPES, PPM_TASK_LIMITS as L,
  type BaseGroup, type ClosedAs, type FieldDef, type FieldType, type TaskMember, type TaskStatusDef, type WriteContext,
} from "../../shared/ppm-tasks.ts";
import { fieldDefRows, loadTask, memberRows, statusById, statusRows } from "./ppm-tasks-db.ts";
import { invalid, notFound } from "./ppm-tasks-errors.ts";
import { writeHistory } from "./ppm-tasks-history.ts";
import { getTaskProject, seedStatuses } from "./ppm-tasks-projects.service.ts";
import { ppmTasksEvents, type PpmTasksEvent } from "./ppm-tasks-events.ts";
import { FIELD_KEY_RE } from "./ppm-tasks-validate.ts";
import { applyChanges, kindForChanges } from "./ppm-tasks-write.ts";

type ConfigWhat = Extract<PpmTasksEvent, { type: "project" }>["what"];

function configChange<T>(projectKey: string, what: ConfigWhat, ctx: WriteContext, now: number, body: () => { result: T; change?: { field: string; before: unknown; after: unknown } }): T {
  if (!getTaskProject(projectKey)) throw notFound("Project");
  let result!: T;
  getDb().transaction(() => {
    const out = body();
    result = out.result;
    if (out.change) writeHistory({ taskId: null, projectKey, ctx, kind: "project", changes: [out.change], at: now });
  })();
  ppmTasksEvents.emit({ type: "project", projectKey, what, actor: ctx.actor, via: ctx.via });
  return result;
}

const name = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim()) throw invalid("A name is required");
  if (value.trim().length > max) throw invalid(`The name is longer than ${max} characters`);
  return value.trim();
};

/** The project's statuses in order; the defaults are seeded for a project that has none yet. */
export function listStatuses(projectKey: string): TaskStatusDef[] {
  const rows = statusRows(projectKey);
  if (rows.length > 0 || !getTaskProject(projectKey)) return rows;
  getDb().transaction(() => seedStatuses(projectKey))();
  return statusRows(projectKey);
}

function checkGroup(baseGroup: unknown, closedAs: unknown): { baseGroup: BaseGroup; closedAs: ClosedAs | null } {
  if (!BASE_GROUPS.includes(baseGroup as BaseGroup)) throw invalid(`baseGroup must be one of ${BASE_GROUPS.join(", ")}`);
  if (baseGroup !== "closed") return { baseGroup: baseGroup as BaseGroup, closedAs: null };
  const as = closedAs ?? "done";
  if (!CLOSED_AS.includes(as as ClosedAs)) throw invalid("closedAs must be done or dropped");
  return { baseGroup: "closed", closedAs: as as ClosedAs };
}

function assertGroupsKept(projectKey: string): void {
  const groups = statusRows(projectKey).map((s) => s.baseGroup);
  if (!groups.includes("not_started")) throw invalid("A project needs at least one not-started status");
  if (!groups.includes("closed")) throw invalid("A project needs at least one closed status");
}

export function addStatus(projectKey: string, input: { name: string; baseGroup: BaseGroup; closedAs?: ClosedAs | null }, ctx: WriteContext, now = Date.now()): TaskStatusDef {
  const n = name(input.name, L.statusName);
  const g = checkGroup(input.baseGroup, input.closedAs);
  return configChange(projectKey, "statuses", ctx, now, () => {
    listStatuses(projectKey);
    if (statusRows(projectKey).some((s) => s.name.toLowerCase() === n.toLowerCase())) throw invalid(`A status named ${n} already exists`);
    const id = crypto.randomUUID();
    const position = statusRows(projectKey).length;
    getDb().query("INSERT INTO task_statuses (id, project_key, name, base_group, closed_as, position) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, projectKey, n, g.baseGroup, g.closedAs, position);
    return { result: statusById(id)!, change: { field: "status.add", before: null, after: { id, name: n, ...g } } };
  });
}

/** Renames, regroups or moves a status. A status tasks use keeps its base group. */
export function updateStatus(id: string, patch: { name?: string; baseGroup?: BaseGroup; closedAs?: ClosedAs | null; position?: number }, ctx: WriteContext, now = Date.now()): TaskStatusDef {
  const before = statusById(id);
  if (!before) throw notFound("Status");
  return configChange(before.projectKey, "statuses", ctx, now, () => {
    const n = patch.name !== undefined ? name(patch.name, L.statusName) : before.name;
    const g = patch.baseGroup !== undefined || patch.closedAs !== undefined
      ? checkGroup(patch.baseGroup ?? before.baseGroup, patch.closedAs ?? before.closedAs) : { baseGroup: before.baseGroup, closedAs: before.closedAs };
    if (g.baseGroup !== before.baseGroup) {
      const used = getDb().query("SELECT 1 FROM tasks WHERE status_id = ? AND deleted_at IS NULL LIMIT 1").get(id);
      if (used) throw invalid("Tasks use this status: move them to another status before changing its group");
    }
    const position = patch.position !== undefined ? Math.max(0, Math.trunc(patch.position)) : before.position;
    getDb().query("UPDATE task_statuses SET name = ?, base_group = ?, closed_as = ?, position = ? WHERE id = ?").run(n, g.baseGroup, g.closedAs, position, id);
    assertGroupsKept(before.projectKey);
    const after = statusById(id)!;
    return { result: after, change: { field: "status.update", before, after } };
  });
}

/** Deletes a status; its tasks (if any) move to `replacementId`, each with its own history row. */
export function deleteStatus(id: string, replacementId: string | null, ctx: WriteContext, now = Date.now()): void {
  const status = statusById(id);
  if (!status) throw notFound("Status");
  configChange(status.projectKey, "statuses", ctx, now, () => {
    const used = getDb().query("SELECT id FROM tasks WHERE status_id = ?").all(id) as Array<{ id: string }>;
    if (used.length > 0) {
      const replacement = replacementId ? statusById(replacementId) : null;
      if (!replacement || replacement.projectKey !== status.projectKey || replacement.id === id) {
        throw invalid("Tasks use this status: name another status of the project to move them to");
      }
      for (const { id: taskId } of used) {
        const task = loadTask(taskId)!;
        const changes = [{ field: "statusId", before: id, after: replacement.id }];
        const kind = kindForChanges(changes);
        applyChanges(task, changes, now);
        writeHistory({ taskId, projectKey: status.projectKey, ctx, kind, changes, at: now });
      }
    }
    getDb().query("DELETE FROM task_statuses WHERE id = ?").run(id);
    assertGroupsKept(status.projectKey);
    return { result: undefined, change: { field: "status.delete", before: status, after: replacementId } };
  });
}

export function listMembers(projectKey: string, includeArchived = false): TaskMember[] {
  return memberRows(projectKey).filter((m) => includeArchived || m.archivedAt === null);
}

type MemberInput = { name?: string; jiraAccountId?: string | null; githubLogin?: string | null; slackUserId?: string | null; position?: number };
const optId = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

export function addMember(projectKey: string, input: MemberInput & { name: string }, ctx: WriteContext, now = Date.now()): TaskMember {
  const n = name(input.name, L.memberName);
  return configChange(projectKey, "members", ctx, now, () => {
    const id = crypto.randomUUID();
    getDb().query("INSERT INTO task_members (id, project_key, name, jira_account_id, github_login, slack_user_id, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectKey, n, optId(input.jiraAccountId), optId(input.githubLogin), optId(input.slackUserId), memberRows(projectKey).length);
    const added = memberRows(projectKey).find((m) => m.id === id)!;
    return { result: added, change: { field: "member.add", before: null, after: added } };
  });
}

export function updateMember(id: string, patch: MemberInput & { archived?: boolean }, ctx: WriteContext, now = Date.now()): TaskMember {
  const row = getDb().query("SELECT project_key FROM task_members WHERE id = ?").get(id) as { project_key: string } | null;
  if (!row) throw notFound("Member");
  return configChange(row.project_key, "members", ctx, now, () => {
    const before = memberRows(row.project_key).find((m) => m.id === id)!;
    const archivedAt = patch.archived === undefined ? before.archivedAt : patch.archived ? (before.archivedAt ?? now) : null;
    getDb().query("UPDATE task_members SET name = ?, jira_account_id = ?, github_login = ?, slack_user_id = ?, position = ?, archived_at = ? WHERE id = ?").run(
      patch.name !== undefined ? name(patch.name, L.memberName) : before.name,
      patch.jiraAccountId !== undefined ? optId(patch.jiraAccountId) : before.jiraAccountId,
      patch.githubLogin !== undefined ? optId(patch.githubLogin) : before.githubLogin,
      patch.slackUserId !== undefined ? optId(patch.slackUserId) : before.slackUserId,
      patch.position !== undefined ? Math.max(0, Math.trunc(patch.position)) : before.position,
      archivedAt, id,
    );
    const after = memberRows(row.project_key).find((m) => m.id === id)!;
    return { result: after, change: { field: "member.update", before, after } };
  });
}

export const listFieldDefs = (projectKey: string): FieldDef[] => fieldDefRows(projectKey);

export function upsertFieldDef(projectKey: string, input: { key: string; label: string; type: FieldType; options?: string[] | null; position?: number }, ctx: WriteContext, now = Date.now()): FieldDef {
  if (typeof input.key !== "string" || !FIELD_KEY_RE.test(input.key)) throw invalid("A field key may use letters, digits, _ . - and at most 64 characters");
  if (!FIELD_TYPES.includes(input.type)) throw invalid(`type must be one of ${FIELD_TYPES.join(", ")}`);
  const label = name(input.label, L.statusName);
  let options: string[] | null = null;
  if (input.type === "select") {
    if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 50) throw invalid("A select field needs 1 to 50 options");
    options = [...new Set(input.options.map((o) => name(o, L.statusName)))];
  }
  return configChange(projectKey, "fields", ctx, now, () => {
    const before = fieldDefRows(projectKey).find((f) => f.key === input.key) ?? null;
    const position = input.position ?? before?.position ?? fieldDefRows(projectKey).length;
    getDb().query(`INSERT INTO task_field_defs (project_key, key, label, type, options_json, position) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, key) DO UPDATE SET label = excluded.label, type = excluded.type, options_json = excluded.options_json, position = excluded.position`)
      .run(projectKey, input.key, label, input.type, options ? JSON.stringify(options) : null, position);
    const after = fieldDefRows(projectKey).find((f) => f.key === input.key)!;
    return { result: after, change: { field: "field.upsert", before, after } };
  });
}

/** Removes the definition only: values tasks hold under the key stay, shown raw. */
export function deleteFieldDef(projectKey: string, key: string, ctx: WriteContext, now = Date.now()): void {
  configChange(projectKey, "fields", ctx, now, () => {
    const before = fieldDefRows(projectKey).find((f) => f.key === key);
    if (!before) throw notFound("Field");
    getDb().query("DELETE FROM task_field_defs WHERE project_key = ? AND key = ?").run(projectKey, key);
    return { result: undefined, change: { field: "field.delete", before, after: null } };
  });
}
