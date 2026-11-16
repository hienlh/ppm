/**
 * The writing `ppm_task_*` tools. Each turns the model's arguments into one service call signed
 * by the caller (`writeContextFor`), so the revision check, the history row and the events are the
 * service's; this layer only names things the way a model does (status and member names, task
 * references, `self`) and says what happened, including what the user and the manager will see.
 */
import { textResult, type Json } from "../../mcp-http-endpoint.ts";
import type { BaseGroup, ClosedAs, FieldType, TaskPatch, TaskView } from "../../../shared/ppm-tasks.ts";
import { ME_MEMBER_ID } from "../../../shared/ppm-tasks.ts";
import {
  PPM_TASK_CLOSE_TOOL, PPM_TASK_CREATE_TOOL, PPM_TASK_NOTIFY_MANAGER_TOOL, PPM_TASK_PROJECT_UPDATE_TOOL, PPM_TASK_REORDER_TOOL,
  PPM_TASK_UNDO_TOOL, PPM_TASK_UPDATE_TOOL,
} from "../../../shared/ppm-task-tools.ts";
import { closeTask, createTask, reorderTask, updateTask, getTask } from "../ppm-tasks.service.ts";
import { historyRow, taskHistory, undoChange } from "../ppm-tasks-history.ts";
import { memberRows, statusRows } from "../ppm-tasks-db.ts";
import { addMember, addStatus, deleteFieldDef, updateMember, updateStatus, upsertFieldDef } from "../ppm-tasks-project-config.ts";
import { setCheckInterval } from "../ppm-tasks-projects.service.ts";
import { managerSessionFor } from "../ppm-tasks-write.ts";
import type { DeliverOutcome } from "../ppm-tasks-deliver.ts";
import type { UnattendedChange } from "../ppm-task-unattended-card.ts";
import { resolveScope, resolveTaskId, TaskToolRefusal, writeContextFor, type TaskCaller, type TaskProjectRef } from "./ppm-task-tool-caller.ts";
import { changeSummary, clean, projectLookup, refOf } from "./ppm-task-tool-format.ts";

export interface WriteToolsEnv {
  projects(): Array<{ name: string; path: string }>;
  wakeManager(projectKey: string, actor: { kind: "assistant"; sessionId: string; label: string }): Promise<DeliverOutcome>;
  noteUnattended(assistantSessionId: string, change: UnattendedChange): void;
}

type Args = Record<string, unknown>;
const refuse = (message: string): never => { throw new TaskToolRefusal(message); };
const has = (a: Args, k: string): boolean => Object.prototype.hasOwnProperty.call(a, k);
const lc = (s: string): string => s.trim().toLowerCase();

function requiredReason(a: Args): string {
  if (typeof a.reason !== "string" || !a.reason.trim()) return refuse("Say why in `reason`: it is shown to the user in the task's history.");
  return a.reason.trim();
}
const optionalReason = (a: Args): string | undefined => (typeof a.reason === "string" && a.reason.trim() ? a.reason.trim() : undefined);

function revisionOf(a: Args): number {
  const r = a.revision;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 0) return refuse("Pass the task's `revision` as you last read it (ppm_task_get).");
  return r;
}

function statusIdFor(projectKey: string, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return refuse("status must be a status name or id of the project.");
  const statuses = statusRows(projectKey);
  const hit = statuses.find((s) => s.id === raw) ?? statuses.find((s) => lc(s.name) === lc(raw));
  return hit ? hit.id : refuse(`No status "${clean(raw, 60)}" in this project. Its statuses: ${statuses.map((s) => clean(s.name, 60)).join(", ")}.`);
}

function memberIdFor(projectKey: string, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) return refuse("A member is named by name or id, `me` for the user, or null.");
  if (lc(raw) === ME_MEMBER_ID || lc(raw) === "you") return ME_MEMBER_ID;
  const members = memberRows(projectKey).filter((m) => m.archivedAt === null);
  const hit = members.find((m) => m.id === raw) ?? members.find((m) => lc(m.name) === lc(raw));
  return hit ? hit.id : refuse(`No member "${clean(raw, 100)}" in this project. Members: ${members.map((m) => clean(m.name, 100)).join(", ") || "none"} (add one with ppm_task_project_update).`);
}

/** The service patch the model's fields describe. Validation of values stays with the service. */
function patchFrom(a: Args, project: TaskProjectRef, scope: TaskProjectRef[], caller: TaskCaller): TaskPatch {
  const p: TaskPatch = {};
  if (has(a, "title")) p.title = a.title as string;
  if (has(a, "type")) p.type = a.type as string;
  if (has(a, "status")) p.statusId = statusIdFor(project.key, a.status);
  if (has(a, "urgency")) p.urgency = a.urgency as TaskPatch["urgency"];
  if (has(a, "importance")) p.importance = a.importance as TaskPatch["importance"];
  if (has(a, "why")) p.why = a.why as string | null;
  if (has(a, "next_step")) p.nextStep = a.next_step as string | null;
  if (has(a, "notes")) p.notes = a.notes as string | null;
  if (has(a, "due_date")) p.dueDate = a.due_date as string | null;
  if (has(a, "tags")) p.tags = a.tags as string[];
  if (has(a, "fields")) p.fields = a.fields as TaskPatch["fields"];
  if (has(a, "assignee")) p.assigneeMemberId = memberIdFor(project.key, a.assignee);
  if (has(a, "waiting_on")) p.waitingOnMemberId = memberIdFor(project.key, a.waiting_on);
  if (has(a, "parent")) p.parentId = a.parent === null ? null : resolveTaskId(a.parent, scope, project).id;
  if (has(a, "working_session")) {
    const w = a.working_session;
    if (w === "self" && caller.kind === "assistant") refuse("A PPM Assistant session cannot be a task's working session.");
    p.workingSessionId = w === "self" ? caller.sessionId : (w as string | null);
  }
  if (has(a, "result")) {
    if (a.result !== null && typeof a.result !== "string") refuse("result must be text, or null to clear it.");
    p.result = a.result === null ? null : { text: a.result as string };
  }
  return p;
}

type Link = { kind: "jira" | "pr" | "session" | "url"; ref: string; label?: string | null };

function linksAfter(task: TaskView, add: unknown, remove: unknown): Link[] | undefined {
  if (add === undefined && remove === undefined) return undefined;
  if (add !== undefined && !Array.isArray(add)) refuse("add_links must be a list.");
  if (remove !== undefined && !Array.isArray(remove)) refuse("remove_links must be a list of refs.");
  const gone = new Set(((remove as unknown[] | undefined) ?? []).map((r) => lc(String(r))));
  const kept: Link[] = task.links.filter((l) => !gone.has(lc(l.ref))).map((l) => ({ kind: l.kind, ref: l.ref, label: l.label }));
  return [...kept, ...((add as Link[] | undefined) ?? [])];
}

interface Written { task: TaskView; kind: string }

/** What the answer to a write says beyond the change: the user's card, the manager's news. */
function afterWrite(env: WriteToolsEnv, caller: TaskCaller, w: Written): string {
  const lookup = projectLookup(w.task.projectKey);
  const lines = [`${w.kind}: ${refOf(w.task, lookup)} "${clean(w.task.title, 200)}" — now revision ${w.task.revision}.`];
  if (caller.unattended) {
    const last = taskHistory(w.task.id, { limit: 1 })[0];
    if (last) env.noteUnattended(caller.sessionId, { historyId: last.id, projectKey: w.task.projectKey, summary: changeSummary(w.kind.toLowerCase(), w.task, lookup) });
    lines.push("This turn was started by PPM, not by the user: the change is marked as made while the user was away and listed on a card the user gets when this turn ends.");
  }
  if (caller.kind === "assistant" && managerSessionFor(w.task.projectKey)) {
    lines.push(caller.unattended
      ? `The ${lookup.name} manager chat reads this change at its next turn. Do not wake it: an unattended turn never does.`
      : `The ${lookup.name} manager chat reads this change at its next turn. Ask the user whether to tell it now (AskUserQuestion, "Tell the ${lookup.name} manager now?"); call ${PPM_TASK_NOTIFY_MANAGER_TOOL} only if they say yes. Never message the manager about it with send_to_session.`);
  }
  return lines.join("\n");
}

function create(env: WriteToolsEnv, caller: TaskCaller, a: Args): Written {
  const scope = resolveScope(caller, a.project, env.projects(), false);
  const project = scope[0]!;
  if (typeof a.title !== "string" || !a.title.trim()) refuse("A task needs a title.");
  const patch = patchFrom(a, project, scope, caller);
  const decision = a.decision && typeof a.decision === "object" ? a.decision as { question?: string | null; options: string[] } : undefined;
  const task = createTask({ ...patch, projectKey: project.key, title: a.title as string, ...(has(a, "links") ? { links: a.links as Link[] } : {}), ...(decision ? { decision } : {}) },
    writeContextFor(caller, optionalReason(a)));
  return { task, kind: "Created" };
}

function update(env: WriteToolsEnv, caller: TaskCaller, a: Args): Written {
  const scope = resolveScope(caller, a.project, env.projects(), caller.kind === "assistant");
  const { id, project } = resolveTaskId(a.task, scope, scope.length === 1 ? scope[0]! : null);
  const reason = requiredReason(a);
  const revision = revisionOf(a);
  const current = getTask(id)!;
  const patch = patchFrom(a, project, scope, caller);
  const links = linksAfter(current, a.add_links, a.remove_links);
  if (links) patch.links = links;
  if (Object.keys(patch).length === 0) refuse("Nothing to change: name at least one field.");
  const task = updateTask(id, patch, revision, writeContextFor(caller, reason));
  return { task, kind: task.revision === current.revision ? "Unchanged" : "Updated" };
}

function close(env: WriteToolsEnv, caller: TaskCaller, a: Args): Written {
  const scope = resolveScope(caller, a.project, env.projects(), caller.kind === "assistant");
  const { id, project } = resolveTaskId(a.task, scope, scope.length === 1 ? scope[0]! : null);
  const reason = requiredReason(a);
  const opts: { closedAs?: ClosedAs; statusId?: string } = has(a, "status") ? { statusId: statusIdFor(project.key, a.status) } : { closedAs: (a.as as ClosedAs | undefined) ?? "done" };
  const task = closeTask(id, opts, revisionOf(a), writeContextFor(caller, reason));
  return { task, kind: `Closed${task.closedAs ? ` as ${task.closedAs}` : ""}` };
}

function reorder(env: WriteToolsEnv, caller: TaskCaller, a: Args): Written {
  const scope = resolveScope(caller, a.project, env.projects(), caller.kind === "assistant");
  const { id, project } = resolveTaskId(a.task, scope, scope.length === 1 ? scope[0]! : null);
  const reason = requiredReason(a);
  if (has(a, "before") === has(a, "after")) refuse("Name exactly one of `before` or `after`.");
  const anchor = resolveTaskId(has(a, "before") ? a.before : a.after, [project], project).id;
  const task = reorderTask(id, has(a, "before") ? { beforeId: anchor } : { afterId: anchor }, revisionOf(a), writeContextFor(caller, reason));
  return { task, kind: "Moved" };
}

function undo(env: WriteToolsEnv, caller: TaskCaller, a: Args): Written {
  const scope = resolveScope(caller, a.project, env.projects(), caller.kind === "assistant");
  const historyId = a.history_id;
  if (typeof historyId !== "number" || !Number.isInteger(historyId) || historyId < 1) refuse("history_id must be the #id of a history row (ppm_task_get).");
  const entry = historyRow(historyId as number);
  if (!entry || !scope.some((s) => s.key === entry.projectKey)) refuse(`No history row #${historyId} in ${scope.length === 1 ? scope[0]!.name : "the projects you can reach"}.`);
  undoChange(historyId as number, writeContextFor(caller, optionalReason(a)));
  return { task: getTask(entry!.taskId!)!, kind: `Undid #${historyId} on` };
}

/** Project set-up changes, applied in order; a refusal names what was already applied. */
function projectUpdate(env: WriteToolsEnv, caller: TaskCaller, a: Args): string {
  const project = resolveScope(caller, a.project, env.projects(), false)[0]!;
  const ctx = writeContextFor(caller, optionalReason(a));
  const done: string[] = [];
  const list = (k: string): Args[] => (Array.isArray(a[k]) ? (a[k] as Args[]) : []);
  const memberId = (raw: unknown): string => {
    const id = memberIdFor(project.key, raw);
    return id && id !== ME_MEMBER_ID ? id : refuse(`No member "${clean(String(raw), 100)}" in this project.`);
  };
  const statusId = (raw: unknown) => statusIdFor(project.key, raw);
  try {
    for (const m of list("add_members")) {
      addMember(project.key, { name: m.name as string, jiraAccountId: m.jira_account_id as string | null, githubLogin: m.github_login as string | null, slackUserId: m.slack_user_id as string | null }, ctx);
      done.push(`added member ${clean(String(m.name), 100)}`);
    }
    for (const m of list("update_members")) {
      const id = memberId(m.member);
      updateMember(id, {
        ...(has(m, "name") ? { name: m.name as string } : {}), ...(has(m, "jira_account_id") ? { jiraAccountId: m.jira_account_id as string | null } : {}),
        ...(has(m, "github_login") ? { githubLogin: m.github_login as string | null } : {}), ...(has(m, "slack_user_id") ? { slackUserId: m.slack_user_id as string | null } : {}),
        ...(has(m, "archived") ? { archived: m.archived as boolean } : {}),
      }, ctx);
      done.push(`updated member ${clean(String(m.member), 100)}`);
    }
    for (const s of list("add_statuses")) {
      addStatus(project.key, { name: s.name as string, baseGroup: s.group as BaseGroup, closedAs: (s.closed_as as ClosedAs | undefined) ?? null }, ctx);
      done.push(`added status ${clean(String(s.name), 60)}`);
    }
    for (const s of list("update_statuses")) {
      updateStatus(statusId(s.status), {
        ...(has(s, "name") ? { name: s.name as string } : {}), ...(has(s, "group") ? { baseGroup: s.group as BaseGroup } : {}),
        ...(has(s, "closed_as") ? { closedAs: s.closed_as as ClosedAs } : {}), ...(has(s, "position") ? { position: s.position as number } : {}),
      }, ctx);
      done.push(`updated status ${clean(String(s.status), 60)}`);
    }
    for (const f of list("upsert_fields")) {
      upsertFieldDef(project.key, { key: f.key as string, label: f.label as string, type: f.type as FieldType, options: (f.options as string[] | undefined) ?? null }, ctx);
      done.push(`saved field ${clean(String(f.key), 64)}`);
    }
    for (const key of Array.isArray(a.delete_fields) ? a.delete_fields : []) {
      deleteFieldDef(project.key, String(key), ctx);
      done.push(`removed field ${clean(String(key), 64)}`);
    }
    if (has(a, "check_interval_min")) {
      setCheckInterval(project.key, a.check_interval_min as number, ctx);
      done.push(`check interval ${a.check_interval_min} min`);
    }
  } catch (e) {
    const applied = done.length ? ` Already applied: ${done.join("; ")}.` : " Nothing was applied.";
    throw new TaskToolRefusal(`${(e as Error).message}.${applied}`);
  }
  if (done.length === 0) refuse("Nothing to change: name at least one change.");
  if (caller.unattended) {
    for (const what of done) env.noteUnattended(caller.sessionId, { historyId: null, projectKey: project.key, summary: `${clean(project.name, 100)} settings: ${what}` });
  }
  return `${project.name}: ${done.join("; ")}.${caller.unattended ? " This turn was started by PPM, not by the user: these changes are listed on a card the user gets when this turn ends." : ""}`;
}

async function notifyManager(env: WriteToolsEnv, caller: TaskCaller, a: Args): Promise<string> {
  if (caller.kind !== "assistant") return refuse(`${PPM_TASK_NOTIFY_MANAGER_TOOL} is for the PPM Assistant only; PPM tells the manager about task changes by itself.`);
  if (caller.unattended) {
    return refuse("This turn was started by PPM, not by the user: it cannot ask the user, so it never wakes the manager. The manager reads the changes at its next turn.");
  }
  const project = resolveScope(caller, a.project, env.projects(), false)[0]!;
  const outcome = await env.wakeManager(project.key, { kind: "assistant", sessionId: caller.sessionId, label: caller.label });
  if (outcome.ok) return `Told the ${project.name} manager chat now (${outcome.delivered}).`;
  switch (outcome.reason) {
    case "no_session": return refuse(`${project.name} has no manager chat.`);
    case "nothing": return refuse(`Nothing to tell: the ${project.name} manager has heard of every task change.`);
    case "budget": return refuse(`Not sent: ${outcome.error ?? "the manager send budget is spent"}. The manager reads the changes at its next turn.`);
    default: return refuse(`Not sent: ${outcome.error ?? outcome.reason}. The manager reads the changes at its next turn.`);
  }
}

export async function callWriteTool(env: WriteToolsEnv, caller: TaskCaller, name: string, a: Args): Promise<Json> {
  switch (name) {
    case PPM_TASK_CREATE_TOOL: return textResult(afterWrite(env, caller, create(env, caller, a)));
    case PPM_TASK_UPDATE_TOOL: {
      const w = update(env, caller, a);
      return textResult(w.kind === "Unchanged" ? `Nothing changed: ${refOf(w.task, projectLookup(w.task.projectKey))} already holds those values (revision ${w.task.revision}).` : afterWrite(env, caller, w));
    }
    case PPM_TASK_CLOSE_TOOL: return textResult(afterWrite(env, caller, close(env, caller, a)));
    case PPM_TASK_REORDER_TOOL: return textResult(afterWrite(env, caller, reorder(env, caller, a)));
    case PPM_TASK_UNDO_TOOL: return textResult(afterWrite(env, caller, undo(env, caller, a)));
    case PPM_TASK_PROJECT_UPDATE_TOOL: return textResult(projectUpdate(env, caller, a));
    case PPM_TASK_NOTIFY_MANAGER_TOOL: return textResult(await notifyManager(env, caller, a));
    default: return textResult(`Unknown tool ${name}`, true);
  }
}
