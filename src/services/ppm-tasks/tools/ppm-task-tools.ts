/**
 * The `ppm_task_*` tools as `/api/sessions-mcp` serves them: the caller comes from the token's
 * chat, reads answer at once, writes are rate-limited per chat and go through the task service.
 * Every refusal is a tool error the model can act on; a stale revision names the current one.
 */
import { textResult, type Json } from "../../mcp-http-endpoint.ts";
import { createSlidingWindowLimiter, type SlidingWindowLimiter } from "../../sliding-window-limiter.ts";
import { configService } from "../../config.service.ts";
import type { BaseGroup, TaskFilter, Urgency } from "../../../shared/ppm-tasks.ts";
import { ME_MEMBER_ID } from "../../../shared/ppm-tasks.ts";
import {
  isPpmTaskWriteTool, PPM_TASK_GET_TOOL, PPM_TASK_LIST_TOOL, PPM_TASK_PROJECT_TOOL,
} from "../../../shared/ppm-task-tools.ts";
import type { CollabCaller } from "../../session-collab/collab-context.ts";
import { childCheckFor, countSnoozed, getTask, listTasks, taskChildren } from "../ppm-tasks.service.ts";
import { taskHistory } from "../ppm-tasks-history.ts";
import { fieldDefRows, memberRows } from "../ppm-tasks-db.ts";
import { listStatuses } from "../ppm-tasks-project-config.ts";
import { getTaskProject } from "../ppm-tasks-projects.service.ts";
import { PpmTaskError, TaskConflictError } from "../ppm-tasks-errors.ts";
import { taskLinkStateSource } from "../ppm-tasks-link-state-source.ts";
import { managerSessionFor } from "../ppm-tasks-write.ts";
import { wakeManager } from "../ppm-tasks-deliver.ts";
import { noteUnattendedChange } from "../ppm-task-unattended-card.ts";
// Loading it registers the manager news wording with the delivery module, so a wake reads like the news entry.
import { managedProjectKey } from "../ppm-task-manager-news.ts";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "./ppm-task-tool-definitions.ts";
import {
  resolveScope, resolveTaskId, taskCallerFrom, TaskToolRefusal, type TaskCaller, type TaskCallerEnv,
} from "./ppm-task-tool-caller.ts";
import { clean, fenced, projectLookup, refOf, taskDetail, taskLine } from "./ppm-task-tool-format.ts";
import { callWriteTool, type WriteToolsEnv } from "./ppm-task-write-tools.ts";

export const TASK_WRITES_PER_MINUTE = 60;

export interface PpmTaskToolsEnv extends TaskCallerEnv, WriteToolsEnv {
  now(): number;
  limiter: SlidingWindowLimiter;
}

type Args = Record<string, unknown>;

const nameMatches = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function list(env: PpmTaskToolsEnv, caller: TaskCaller, a: Args): string {
  const scope = resolveScope(caller, a.project, env.projects(), true);
  if (scope.length === 0) return "No project has Tasks switched on in PPM.";
  const filter: TaskFilter = {
    projectKeys: scope.map((s) => s.key), includeClosed: a.include_closed === true, snoozed: a.include_snoozed === true ? "include" : "exclude",
  };
  if (typeof a.status_group === "string") filter.baseGroups = [a.status_group as BaseGroup];
  if (typeof a.type === "string" && a.type.trim()) filter.types = [a.type.trim()];
  if (typeof a.tag === "string" && a.tag.trim()) filter.tag = a.tag.trim();
  if (typeof a.query === "string" && a.query.trim()) filter.text = a.query.trim();
  let tasks = listTasks(filter);
  if (typeof a.person === "string" && a.person.trim()) {
    const person = a.person.trim();
    const ids = new Set(person.toLowerCase() === ME_MEMBER_ID ? [ME_MEMBER_ID]
      : scope.flatMap((s) => memberRows(s.key).filter((m) => m.id === person || nameMatches(m.name, person)).map((m) => m.id)));
    if (ids.size === 0) return `No member "${clean(person, 100)}" in ${scope.length === 1 ? scope[0]!.name : "these projects"}.`;
    tasks = tasks.filter((t) => (t.assigneeMemberId && ids.has(t.assigneeMemberId)) || (t.waitingOnMemberId && ids.has(t.waitingOnMemberId)));
  }
  if (typeof a.urgency === "string") tasks = tasks.filter((t) => t.effectiveUrgency === (a.urgency as Urgency));
  const limit = typeof a.limit === "number" && Number.isInteger(a.limit) ? Math.min(Math.max(a.limit, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const shown = tasks.slice(0, limit);
  const snoozedOut = a.include_snoozed === true ? 0 : countSnoozed(scope.map((s) => s.key));
  const snoozedNote = snoozedOut ? ` ${snoozedOut} snoozed task${snoozedOut === 1 ? " is" : "s are"} left out (hidden until a day or a link change; include_snoozed: true lists ${snoozedOut === 1 ? "it" : "them"}).` : "";
  if (shown.length === 0) return `No tasks match in ${scope.map((s) => s.name).join(", ")}.${snoozedNote}`;
  const now = env.now();
  const lookups = new Map(scope.map((s) => [s.key, projectLookup(s.key)]));
  const lines = shown.map((t) => taskLine(t, lookups.get(t.projectKey) ?? projectLookup(t.projectKey), childCheckFor(t), now));
  const more = tasks.length > shown.length ? ` (${tasks.length - shown.length} more: narrow the filter or raise limit)` : "";
  return `${shown.length} of ${tasks.length} task${tasks.length === 1 ? "" : "s"}, what to do first at the top${more}. Use ppm_task_get for one task's details.${snoozedNote}\n${fenced(lines)}`;
}

function get(env: PpmTaskToolsEnv, caller: TaskCaller, a: Args): string {
  const scope = resolveScope(caller, a.project, env.projects(), caller.kind === "assistant");
  const { id } = resolveTaskId(a.task, scope, scope.length === 1 ? scope[0]! : null);
  const task = getTask(id)!;
  const source = taskLinkStateSource();
  const session = task.workingSessionId ? source.sessionState(task.workingSessionId) : null;
  const sessionState = session ? `${session.state}${session.title ? ` — "${clean(session.title, 120)}"` : ""}` : null;
  return taskDetail({
    task, check: childCheckFor(task), children: taskChildren(task.id), history: taskHistory(task.id, { limit: 20 }),
    linkStates: source.states(task.projectKey, task.links), sessionState,
  }, env.now());
}

function project(env: PpmTaskToolsEnv, caller: TaskCaller, a: Args): string {
  const ref = resolveScope(caller, a.project, env.projects(), false)[0]!;
  const p = getTaskProject(ref.key)!;
  const statuses = listStatuses(ref.key);
  const members = memberRows(ref.key).filter((m) => m.archivedAt === null);
  const fields = fieldDefRows(ref.key);
  const lines = [
    `project ${clean(ref.name, 100)}: Tasks ${p.enabled ? "on" : "off"}; ${managerSessionFor(ref.key) ? "has a manager chat" : "no manager chat"}; handed-off work checked every ${p.checkIntervalMin} min`,
    `statuses: ${statuses.map((s) => `${clean(s.name, 60)} [${s.baseGroup}${s.closedAs ? `, ${s.closedAs}` : ""}]`).join("; ")}`,
    `members: ${members.length ? members.map((m) => `${clean(m.name, 100)} (id ${m.id}${m.jiraAccountId ? `, jira ${clean(m.jiraAccountId, 60)}` : ""}${m.githubLogin ? `, github ${clean(m.githubLogin, 60)}` : ""})`).join("; ") : "none"} — \`me\` is the user`,
    `fields: ${fields.length ? fields.map((f) => `${clean(f.key, 64)} "${clean(f.label, 60)}" ${f.type}${f.options ? ` [${f.options.map((o) => clean(o, 60)).join(", ")}]` : ""}`).join("; ") : "none"}`,
  ];
  return fenced(lines);
}

/** The text a refusal or a service error answers with. */
function errorText(e: unknown): string {
  if (e instanceof TaskConflictError) {
    const task = getTask(e.taskId);
    const ref = task ? refOf(task, projectLookup(task.projectKey)) : "The task";
    return `Task ${ref} changed since you read it (now revision ${e.currentRevision}). Call ppm_task_get and retry.`;
  }
  // Messages may quote names people or AIs stored (statuses, members): defused like task text.
  if (e instanceof TaskToolRefusal || e instanceof PpmTaskError) return clean(e.message, 2_000);
  return `The task tool failed: ${clean((e as Error)?.message ?? String(e), 1_000)}`;
}

export async function callPpmTaskTool(env: PpmTaskToolsEnv, collabCaller: CollabCaller, name: string, rawArgs: unknown): Promise<Json> {
  const channel = collabCaller.kind === "assistant" ? await env.turnChannel(collabCaller.sessionId, collabCaller.providerId) : null;
  const caller = taskCallerFrom(collabCaller, collabCaller.kind !== "assistant" && env.isManagerChat(collabCaller.sessionId), channel);
  const a: Args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Args : {};
  try {
    if (name === PPM_TASK_LIST_TOOL) return textResult(list(env, caller, a));
    if (name === PPM_TASK_GET_TOOL) return textResult(get(env, caller, a));
    if (name === PPM_TASK_PROJECT_TOOL) return textResult(project(env, caller, a));
    if (!isPpmTaskWriteTool(name)) return textResult(`Unknown tool ${name}`, true);
    const refused = env.limiter.take(caller.sessionId, env.now());
    if (refused) {
      return textResult(`Too many task changes from this chat: at most ${TASK_WRITES_PER_MINUTE} a minute. Try again in ${Math.ceil(refused.retryMs / 1000)} s.`, true);
    }
    return await callWriteTool(env, caller, name, a);
  } catch (e) {
    return textResult(errorText(e), true);
  }
}

export const createTaskWriteLimiter = (): SlidingWindowLimiter =>
  createSlidingWindowLimiter({ windowMs: 60_000, max: TASK_WRITES_PER_MINUTE }, { maxKeys: 2_048 });

const liveLimiter = createTaskWriteLimiter();

/** The live environment; the chat service loads on first use (it loads after this module). */
export function livePpmTaskToolsEnv(): PpmTaskToolsEnv {
  return {
    now: () => Date.now(),
    limiter: liveLimiter,
    projects: () => configService.get("projects"),
    isManagerChat: (sessionId) => managedProjectKey(sessionId) !== null,
    turnChannel: async (sessionId, providerId) => {
      try {
        return (await import("../../chat.service.ts")).chatService.turnChannelOf(providerId, sessionId);
      } catch {
        return null;
      }
    },
    wakeManager: (projectKey, actor) => wakeManager(projectKey, actor),
    noteUnattended: noteUnattendedChange,
  };
}

