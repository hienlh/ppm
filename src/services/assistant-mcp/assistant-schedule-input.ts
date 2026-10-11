import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { resolveAssistantProject, type AssistantProject } from "./assistant-project-scope.ts";
import type { ScheduleField, ScheduleSettings } from "./assistant-approval-summary-schedule.ts";
import { cronProblem } from "./assistant-schedule-shape.ts";

/**
 * What `schedule_save` was given, checked before any card is built, and how it maps onto the
 * route's body. The checks are the route's own (a cron croner accepts, a timeout of at least
 * 10 s, a positive turn limit) plus the bounds a card needs to show every value whole.
 */

export const MAX_SCHEDULE_NAME_CHARS = 200;
export const MAX_SCHEDULE_CRON_CHARS = 200;
export const MAX_SCHEDULE_PROMPT_CHARS = 20_000;
const MAX_TURNS = 10_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
/** What a schedule gets when the agent names none: the Settings form's defaults, sent explicitly. */
export const DEFAULT_SCHEDULE_MODE = "bypassPermissions";
export const DEFAULT_SCHEDULE_TIMEOUT_MS = 1_800_000;

// eslint-disable-next-line no-control-regex -- control characters are what this pattern is for
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export interface GivenSchedule {
  name?: string;
  cron?: string;
  project?: AssistantProject;
  prompt?: string;
  permissionMode?: string;
  maxTurns?: number | null;
  timeoutMs?: number;
  enabled?: boolean;
}

type Parsed = { ok: true; given: GivenSchedule } | { ok: false; error: string };

/** Every field the agent passed, checked; absent fields stay absent (an edit changes only those). */
export function parseGivenSchedule(args: Record<string, unknown>, projects: AssistantProject[]): Parsed {
  const given: GivenSchedule = {};
  if (args.name !== undefined) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name || name.length > MAX_SCHEDULE_NAME_CHARS || CONTROL_CHARS.test(name)) {
      return { ok: false, error: `\`name\` must be one line of 1 to ${MAX_SCHEDULE_NAME_CHARS} characters.` };
    }
    given.name = name;
  }
  if (args.cron !== undefined) {
    const cron = typeof args.cron === "string" ? args.cron.trim() : "";
    if (!cron || cron.length > MAX_SCHEDULE_CRON_CHARS || CONTROL_CHARS.test(cron)) return { ok: false, error: "`cron` must be a cron expression such as \"0 7 * * 1-5\"." };
    const problem = cronProblem(cron);
    if (problem) return { ok: false, error: `\`cron\` is not a valid cron expression: ${problem}` };
    given.cron = cron;
  }
  if (args.project !== undefined) {
    const project = resolveAssistantProject(args.project, () => projects);
    if (!project.ok) return { ok: false, error: project.error };
    given.project = project.value;
  }
  if (args.prompt !== undefined) {
    // Kept exactly as written: the card shows it whole and this is the text that will run.
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > MAX_SCHEDULE_PROMPT_CHARS) {
      return { ok: false, error: `\`prompt\` must be text of 1 to ${MAX_SCHEDULE_PROMPT_CHARS} characters.` };
    }
    given.prompt = args.prompt;
  }
  if (args.permissionMode !== undefined) {
    if (!VALID_PERMISSION_MODES.includes(args.permissionMode as never)) {
      return { ok: false, error: `\`permissionMode\` must be one of ${VALID_PERMISSION_MODES.join(", ")}.` };
    }
    given.permissionMode = args.permissionMode as string;
  }
  if (args.maxTurns !== undefined) {
    // 0 (what the schema offers) and null both mean "no limit", which the route stores as null.
    const n = args.maxTurns;
    if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_TURNS)) {
      return { ok: false, error: `\`maxTurns\` must be a whole number from 1 to ${MAX_TURNS}, or 0 for no limit.` };
    }
    given.maxTurns = n === 0 || n === null ? null : (n as number);
  }
  if (args.timeoutMinutes !== undefined) {
    const minutes = args.timeoutMinutes;
    const ms = typeof minutes === "number" && Number.isFinite(minutes) ? Math.round(minutes * 60_000) : NaN;
    if (!(ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS)) return { ok: false, error: "`timeoutMinutes` must be a number of minutes from 0.17 (10 seconds) to 10080 (a week)." };
    given.timeoutMs = ms;
  }
  if (args.enabled !== undefined) {
    if (typeof args.enabled !== "boolean") return { ok: false, error: "`enabled` must be true or false." };
    given.enabled = args.enabled;
  }
  return { ok: true, given };
}

/** A stored schedule as a card shows it, under the project its folder is. */
export const settingsOf = (s: Schedule, project: AssistantProject): ScheduleSettings => ({
  name: s.name, cron: s.cron_expr, project: project.name, folder: s.project_path, prompt: s.prompt,
  permissionMode: s.permission_mode, maxTurns: s.max_turns, timeoutMs: s.timeout_ms, enabled: s.enabled === 1,
});

/** `before` with what was given laid over it. */
export function applyGiven(before: ScheduleSettings, given: GivenSchedule): ScheduleSettings {
  return {
    name: given.name ?? before.name,
    cron: given.cron ?? before.cron,
    project: given.project?.name ?? before.project,
    folder: given.project ? (given.project.name === before.project ? before.folder : given.project.path) : before.folder,
    prompt: given.prompt ?? before.prompt,
    permissionMode: given.permissionMode ?? before.permissionMode,
    maxTurns: given.maxTurns !== undefined ? given.maxTurns : before.maxTurns,
    timeoutMs: given.timeoutMs ?? before.timeoutMs,
    enabled: given.enabled ?? before.enabled,
  };
}

/** The order changes are listed in on a card; `folder` moves with `project`. */
const FIELDS: ScheduleField[] = ["enabled", "name", "project", "cron", "permissionMode", "maxTurns", "timeoutMs", "prompt"];

export const changedFields = (before: ScheduleSettings, after: ScheduleSettings): ScheduleField[] =>
  FIELDS.filter((k) => before[k] !== after[k]);

/** The route's body for `fields` of `after`. */
export function routeBody(after: ScheduleSettings, fields: readonly ScheduleField[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of fields) {
    if (k === "name") body.name = after.name;
    else if (k === "cron") body.cron_expr = after.cron;
    else if (k === "project" || k === "folder") body.project_path = after.folder;
    else if (k === "prompt") body.prompt = after.prompt;
    else if (k === "permissionMode") body.permission_mode = after.permissionMode;
    else if (k === "maxTurns") body.max_turns = after.maxTurns;
    else if (k === "timeoutMs") body.timeout_ms = after.timeoutMs;
    else if (k === "enabled") body.enabled = after.enabled;
  }
  return body;
}
