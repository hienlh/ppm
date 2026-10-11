import { textResult, type Json } from "../mcp-http-endpoint.ts";
import type { Schedule } from "../../types/scheduler.ts";
import {
  SCHEDULE_DELETE_TOOL, SCHEDULE_RUN_NOW_TOOL, SCHEDULE_SAVE_TOOL,
} from "../../shared/assistant-schedule-tool-names.ts";
import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { AssistantProject } from "./assistant-project-scope.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import {
  createScheduleSummary, deleteScheduleSummary, editScheduleSummary, runNowScheduleSummary, type ScheduleSettings,
} from "./assistant-approval-summary-schedule.ts";
import {
  applyGiven, changedFields, DEFAULT_SCHEDULE_MODE, DEFAULT_SCHEDULE_TIMEOUT_MS, parseGivenSchedule, routeBody, settingsOf,
  type GivenSchedule,
} from "./assistant-schedule-input.ts";
import {
  defaultProviderOf, idArg, nextRunTimes, projectOfFolder, readRuns, readSchedule, registeredProjects, scheduleView,
  schedulePath, timeZoneOf, unchangedSince, type ScheduleDeps,
} from "./assistant-schedule-shape.ts";

/**
 * `schedule_save`, `schedule_delete`, `schedule_run_now`: each asks first, with a card built from
 * the schedule as the route reads it, and has no path that runs without `ctx.ask` approving — so
 * a watch turn, which refuses every ask, changes nothing. Only a schedule whose folder is a
 * registered project may be changed. A card can wait for hours, so after the approval the
 * schedule is read again and anything the card showed that changed meanwhile stops the call
 * (`stale`): the user approves exactly what they saw.
 */

const DELETE_RUNS_COUNTED = 200;

function staleResult(action: string, reason: string): Json {
  return textResult(JSON.stringify({
    outcome: "stale", action, reason,
    note: "Nothing was done. Read the schedule again; ask again only if the change is still what the user wants.",
  }, null, 1), true);
}

/** The schedule `id` with its registered project, or why the tools may not change it. */
async function changeableSchedule(ctx: ToolContext, id: number, projects: AssistantProject[]) {
  const read = await readSchedule(ctx, id);
  if (!read.ok) return read;
  const project = projectOfFolder(read.schedule.project_path, projects);
  if (!project) {
    return {
      ok: false as const,
      error: `Schedule ${id} runs in ${read.schedule.project_path}, which is not a registered project. The Assistant `
        + "changes only schedules of registered projects; the user can change this one in Settings → Schedules.",
    };
  }
  return { ok: true as const, schedule: read.schedule, project, settings: settingsOf(read.schedule, project) };
}

/** Re-reads `seen` after approval; null when it is still what the card showed. */
async function recheck(ctx: ToolContext, seen: Schedule, action: string): Promise<Json | null> {
  const again = await readSchedule(ctx, seen.id);
  if (!again.ok) return staleResult(action, `Schedule ${seen.id} could not be read again after approval: ${again.error}`);
  return unchangedSince(seen, again.schedule) ? null : staleResult(action, `Schedule ${seen.id} was changed while the card waited.`);
}

const nextRunsFor = (cron: string, deps: ScheduleDeps) => ({ times: nextRunTimes(cron), timeZone: timeZoneOf(deps) });

async function ask(ctx: ToolContext, tool: string, input: Record<string, unknown>, summary: ApprovalSummary): Promise<Json | null> {
  const verdict = await ctx.ask({ tool, input, summary });
  return verdict.verdict === "approved" ? null : notApprovedResult(tool, verdict, input);
}

export async function scheduleSave(ctx: ToolContext, args: Record<string, unknown>, deps: ScheduleDeps = {}): Promise<Json> {
  const projects = registeredProjects(deps);
  const parsed = parseGivenSchedule(args, projects);
  if (!parsed.ok) return errorResult(parsed.error);
  if (args.id === undefined || args.id === null) return createSchedule(ctx, parsed.given, deps);
  const id = idArg(args.id);
  if (id === null) return errorResult("`id` must be a schedule id from schedules_list, or left out to create one.");
  return editSchedule(ctx, id, parsed.given, projects, deps);
}

async function createSchedule(ctx: ToolContext, given: GivenSchedule, deps: ScheduleDeps): Promise<Json> {
  const missing = (["name", "cron", "project", "prompt"] as const).filter((k) => given[k] === undefined);
  if (missing.length) return errorResult(`To create a schedule, give ${missing.map((k) => `\`${k}\``).join(", ")} (or \`id\` to edit one).`);
  const project = given.project!;
  // Every value is sent explicitly, defaults included, so what is stored is what the card showed.
  const settings: ScheduleSettings = {
    name: given.name!, cron: given.cron!, project: project.name, folder: project.path, prompt: given.prompt!,
    permissionMode: given.permissionMode ?? DEFAULT_SCHEDULE_MODE, maxTurns: given.maxTurns ?? null,
    timeoutMs: given.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS, enabled: given.enabled ?? true,
  };
  const provider = defaultProviderOf(deps);
  const body = routeBody(settings, ["name", "cron", "project", "prompt", "permissionMode", "maxTurns", "timeoutMs", "enabled"]);
  const refused = await ask(ctx, SCHEDULE_SAVE_TOOL, { project: project.name, provider, ...body }, createScheduleSummary({
    settings, provider, nextRuns: nextRunsFor(settings.cron, deps), modeChosen: given.permissionMode !== undefined,
  }));
  if (refused) return refused;
  // The route snapshots the default provider; the card named one, so it must still be that one.
  if (defaultProviderOf(deps) !== provider) return staleResult(SCHEDULE_SAVE_TOOL, "The default provider changed while the card waited.");

  const res = await ctx.callRoute<Schedule>("POST", "/api/schedules", body);
  if (!res.ok || !res.data) return errorResult(`Not created: ${res.error ?? `the route answered ${res.status}`}`);
  return jsonResult({ created: true, schedule: scheduleView(res.data, project) });
}

async function editSchedule(ctx: ToolContext, id: number, given: GivenSchedule, projects: AssistantProject[], deps: ScheduleDeps): Promise<Json> {
  const current = await changeableSchedule(ctx, id, projects);
  if (!current.ok) return errorResult(current.error);
  const before = current.settings;
  const after = applyGiven(before, given);
  const changed = changedFields(before, after);
  if (changed.length === 0) return errorResult(`Nothing would change: schedule ${id} already has those settings.`);

  const body = routeBody(after, changed);
  const refused = await ask(ctx, SCHEDULE_SAVE_TOOL, { id, project: after.project, ...body }, editScheduleSummary({
    id, before, after, changed, provider: current.schedule.provider_id, nextRuns: nextRunsFor(after.cron, deps),
  }));
  if (refused) return refused;
  const stale = await recheck(ctx, current.schedule, SCHEDULE_SAVE_TOOL);
  if (stale) return stale;

  const res = await ctx.callRoute<Schedule>("PATCH", schedulePath(id), body);
  if (!res.ok || !res.data) return errorResult(`Not changed: ${res.error ?? `the route answered ${res.status}`}`);
  return jsonResult({
    updated: true, changed,
    previous: scheduleView(current.schedule, current.project),
    schedule: scheduleView(res.data, projectOfFolder(res.data.project_path, projects)),
  });
}

export async function scheduleDelete(ctx: ToolContext, args: Record<string, unknown>, deps: ScheduleDeps = {}): Promise<Json> {
  const id = idArg(args.id);
  if (id === null) return errorResult("`id` is required: a schedule id from schedules_list.");
  const current = await changeableSchedule(ctx, id, registeredProjects(deps));
  if (!current.ok) return errorResult(current.error);
  const runs = await readRuns(ctx, id, DELETE_RUNS_COUNTED);
  if (runs === null) return errorResult(`Could not count the runs of schedule ${id}; nothing was deleted.`);

  const refused = await ask(ctx, SCHEDULE_DELETE_TOOL, { id, project: current.project.name }, deleteScheduleSummary({
    id, settings: current.settings, runs: runs.length, runsCapped: runs.length >= DELETE_RUNS_COUNTED,
  }));
  if (refused) return refused;
  const stale = await recheck(ctx, current.schedule, SCHEDULE_DELETE_TOOL);
  if (stale) return stale;

  const res = await ctx.callRoute("DELETE", schedulePath(id));
  if (!res.ok) return errorResult(`Not deleted: ${res.error ?? `the route answered ${res.status}`}`);
  return jsonResult({
    deleted: true,
    runsDeleted: runs.length >= DELETE_RUNS_COUNTED ? `${DELETE_RUNS_COUNTED}+` : runs.length,
    schedule: scheduleView(current.schedule, current.project),
    note: "To recreate it, call schedule_save with these settings (it gets a new id; the run history is gone).",
  });
}

export async function scheduleRunNow(ctx: ToolContext, args: Record<string, unknown>, deps: ScheduleDeps = {}): Promise<Json> {
  const id = idArg(args.id);
  if (id === null) return errorResult("`id` is required: a schedule id from schedules_list.");
  const current = await changeableSchedule(ctx, id, registeredProjects(deps));
  if (!current.ok) return errorResult(current.error);
  const running = (await readRuns(ctx, id, 1))?.[0]?.status === "running";

  const refused = await ask(ctx, SCHEDULE_RUN_NOW_TOOL, { id, project: current.project.name }, runNowScheduleSummary({
    id, settings: current.settings, provider: current.schedule.provider_id, running,
  }));
  if (refused) return refused;
  // The card showed the prompt and mode that will run; an edit meanwhile would run something else.
  const stale = await recheck(ctx, current.schedule, SCHEDULE_RUN_NOW_TOOL);
  if (stale) return stale;

  const res = await ctx.callRoute<{ runId: number; wasRunning: boolean }>("POST", schedulePath(id, "run-now"));
  if (!res.ok || !res.data) return errorResult(`Not started: ${res.error ?? `the route answered ${res.status}`}`);
  return jsonResult({
    started: true, scheduleId: id, runId: res.data.runId, wasRunning: res.data.wasRunning,
    project: current.project.name, sessionId: current.schedule.session_id,
    note: "The run goes on in the background. Read its result with schedule_get; once the schedule has a sessionId, "
      + "chat_watch (project + sessionId) reports when it finishes.",
  });
}
