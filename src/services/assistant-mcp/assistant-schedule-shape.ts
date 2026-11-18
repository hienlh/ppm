import { resolve } from "node:path";
import { Cron } from "croner";
import type { Schedule, ScheduleOverview, ScheduleRun } from "../../types/scheduler.ts";
import { configService } from "../config.service.ts";
import { projectService } from "../project.service.ts";
import { isInsideDir, realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import type { AssistantProject } from "./assistant-project-scope.ts";
import { withQuery } from "./assistant-route-rules.ts";
import { localMomentText } from "../../shared/task-reminder.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * What the schedule tools share: which registered project a schedule's folder is, the view of
 * a schedule they hand back, and the reads every write starts from. A schedule stores a raw
 * folder (`project_path`), not a project name, so the tools translate both ways here.
 */

export interface ScheduleDeps {
  /** The registered projects; a schedule may be changed only when its folder is one of them. */
  projects?: () => AssistantProject[];
  /** The provider a new schedule is snapshotted to, read the way the route reads it. */
  defaultProvider?: () => string;
  /**
   * The machine's own zone: a prompt or script schedule's cron is read in it, and so is a session
   * schedule saved with no zone of its own. A session schedule with one is read in that one.
   */
  timeZone?: () => string;
}

export const registeredProjects = (deps: ScheduleDeps): AssistantProject[] =>
  (deps.projects ?? (() => projectService.list()))().filter((p) => !isAssistantProject(p.name));

export const defaultProviderOf = (deps: ScheduleDeps): string =>
  (deps.defaultProvider ?? (() => String(configService.get("ai")?.default_provider ?? "claude")))();

export const timeZoneOf = (deps: ScheduleDeps): string =>
  (deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "server local time"))();

/** A path in the one spelling two names of the same folder share (symlinks, Windows case). */
const canonical = (path: string): string => realPathOrSelfSync(resolve(path));

/**
 * The registered project whose folder *is* `folder`, or null. Equality, not containment: a
 * schedule in a subfolder of a project is not that project's schedule as the Settings form
 * offers it, so it is not one the tools may change either.
 */
export function projectOfFolder(folder: string, projects: AssistantProject[]): AssistantProject | null {
  const target = canonical(folder);
  return projects.find((p) => {
    const path = canonical(p.path);
    return isInsideDir(target, path) && isInsideDir(path, target);
  }) ?? null;
}

/** A positive schedule id, or null. */
export function idArg(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The zone `s`'s cron is read in: its own, else the machine's. */
export const scheduleZone = (s: Pick<Schedule, "timezone">, machineZone: string): string => s.timezone ?? machineZone;

/**
 * The schedule as the tools describe it: camelCase, the project by name, the folder kept, and the
 * zone its cron is read in. A session schedule's own zone (a reminder kept in UK time) can differ
 * from the machine's, and `nextFireAt` (UTC) only reads right against the zone it was computed in.
 */
export function scheduleView(s: Schedule, project: AssistantProject | null, machineZone: string) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    cron: s.cron_expr,
    timeZone: scheduleZone(s, machineZone),
    ...(s.timezone === null && { timeZoneIsMachineLocal: true }),
    recurring: s.recurring === 1,
    ...(s.kind === "session" && { targetSessionId: s.target_session_id }),
    ...(s.task_id && { taskId: s.task_id }),
    project: project?.name ?? null,
    folder: s.project_path,
    provider: s.provider_id,
    // The routes answer overviews: a chat reminder runs in its chat's mode, not the row's column.
    permissionMode: (s as Partial<ScheduleOverview>).effective_permission_mode ?? s.permission_mode,
    enabled: s.enabled === 1,
    maxTurns: s.max_turns,
    timeoutMinutes: s.timeout_ms / 60_000,
    nextFireAt: s.next_fire_at,
    lastRunAt: s.last_run_at,
    sessionId: s.session_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    prompt: s.prompt,
  };
}

/** Fields a person decides; a card shows these, so an approval covers exactly these values. */
const DECIDED: ReadonlyArray<keyof Schedule> = [
  "name", "cron_expr", "project_path", "prompt", "permission_mode", "max_turns", "timeout_ms", "enabled", "provider_id",
  // What a script schedule runs, and when: a card turning one on shows the script.
  "kind", "mode", "script", "inputs_json", "input_values_json", "timezone",
];

/**
 * Whether `now` is still the schedule the card described, compared field by field over what a
 * person decides. `updated_at` cannot answer it either way: it has one-second resolution, so an
 * edit in the same second as the card's read leaves it equal, and the scheduler bumps it after
 * every run (`last_run_at`, `next_fire_at`) and when a run opens its chat, so a schedule firing
 * every few minutes would never look unchanged.
 */
export function unchangedSince(seen: Schedule, now: Schedule): boolean {
  return DECIDED.every((k) => seen[k] === now[k]);
}

export const schedulePath = (id: number, sub = ""): string => `/api/schedules/${id}${sub ? `/${sub}` : ""}`;

/** One schedule through the route, or why it could not be read. */
export async function readSchedule(ctx: ToolContext, id: number): Promise<{ ok: true; schedule: Schedule } | { ok: false; error: string }> {
  const res = await ctx.callRoute<Schedule>("GET", schedulePath(id));
  if (res.status === 404) return { ok: false, error: `No schedule has id ${id}; see schedules_list.` };
  if (!res.ok || !res.data) return { ok: false, error: `Could not read schedule ${id}: ${res.error ?? `the route answered ${res.status}`}` };
  return { ok: true, schedule: res.data };
}

/** The newest `limit` runs of a schedule, newest first; null when they cannot be read. */
export async function readRuns(ctx: ToolContext, id: number, limit: number): Promise<ScheduleRun[] | null> {
  const res = await ctx.callRoute<ScheduleRun[]>("GET", withQuery(schedulePath(id, "runs"), { limit }));
  return res.ok && Array.isArray(res.data) ? res.data : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `2026-10-12 07:00` on the clock of `timeZone`, the machine's when absent. */
export function localTime(d: Date, timeZone?: string | null): string {
  if (!timeZone) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return localMomentText(d, timeZone).replace("T", " ");
}

/** Why `expr` is not a cron expression the route will take, or null. */
export function cronProblem(expr: string): string | null {
  try {
    new Cron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * The next `count` times `expr` fires read in `timeZone` (the machine's when null), printed on that
 * same clock; empty when it never fires again.
 */
export function nextRunTimes(expr: string, count = 3, timeZone: string | null = null): string[] {
  try {
    return new Cron(expr, timeZone ? { timezone: timeZone } : {}).nextRuns(count).map((d) => localTime(d, timeZone));
  } catch {
    return [];
  }
}
