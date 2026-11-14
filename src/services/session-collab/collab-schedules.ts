/**
 * `session_schedule_create`, `session_schedule_list`, `session_schedule_delete`: the AI schedules
 * prompts into its own chat. The chat is the one the token names, resolved to its current id and
 * never taken from the arguments, so a chat can neither see nor touch another chat's schedules.
 * Saving goes through the same function as the REST route and the CLI (`session-schedule-save.ts`).
 */
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../shared/session-schedule-input.ts";
import {
  SESSION_SCHEDULE_CREATE_TOOL, SESSION_SCHEDULE_LIST_TOOL, type SessionScheduleTool,
} from "../../shared/session-schedule-tools.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { deleteSchedule, getSchedule } from "../scheduler-db.service.ts";
import { ScheduleEditError } from "../scheduler-edit.ts";
import { SessionScheduleRefusal, sessionScheduleTargetIds } from "../session-schedules/session-schedule-lifecycle.ts";
import { createSessionSchedule, sessionSchedulesOf } from "../session-schedules/session-schedule-save.ts";
import { announceSchedulesChanged } from "../session-schedules/session-schedules-changed.ts";
import { liveScheduleTargetDeps, resolveScheduleTarget, type ScheduleTargetDeps } from "../session-schedules/session-schedule-target.ts";

export interface SessionScheduleToolEnv {
  target: ScheduleTargetDeps;
  /** A schedule was added or removed: re-arm the scheduler and refresh open schedule lists. */
  changed(): void;
  now(): Date;
  /** The machine's own zone, which a schedule with none is read in. */
  localZone(): string;
}

export const liveSessionScheduleToolEnv: SessionScheduleToolEnv = {
  target: liveScheduleTargetDeps,
  changed: announceSchedulesChanged,
  now: () => new Date(),
  localZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

const json = (value: unknown, isError = false): Json => textResult(JSON.stringify(value, null, 1), isError);
const fail = (message: string): Json => textResult(message, true);

/** `2026-11-17 Mon 09:00` in `zone`: the wall clock the user reads the schedule by. */
function wallClock(iso: string, zone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`;
}

/** A schedule as the AI reads it, its times on the schedule's own wall clock. */
function describe(s: Schedule, env: SessionScheduleToolEnv): Json {
  const zone = s.timezone ?? env.localZone();
  const repeats = s.recurring === 1;
  return {
    id: s.id,
    name: s.name,
    prompt: s.prompt,
    cron: s.cron_expr,
    timeZone: zone,
    ...(s.timezone === null && { timeZoneIsMachineLocal: true }),
    recurring: repeats,
    schedule: repeats
      ? `Every match of "${s.cron_expr}" (minute hour day-of-month month day-of-week) in ${zone}, until deleted.`
      : `Once, at the next match of "${s.cron_expr}" in ${zone}; then it deletes itself.`,
    enabled: s.enabled === 1,
    nextFire: s.next_fire_at ? { at: s.next_fire_at, local: wallClock(s.next_fire_at, zone) } : null,
    ...(s.pending_since && { waitingSince: s.pending_since, waiting: "It came due and is delivered once this chat is idle." }),
    ...(s.paused_reason && { pausedReason: s.paused_reason }),
  };
}

function refusalText(e: unknown): string {
  if (e instanceof ScheduleEditError) return `Not saved: ${e.problems.join("; ")}.`;
  if (e instanceof SessionScheduleRefusal) return `Not saved: ${e.message}`;
  return `Not saved: ${(e as Error).message}`;
}

export function sessionScheduleToolCall(env: SessionScheduleToolEnv, tokenSessionId: string, name: SessionScheduleTool, rawArgs: unknown): Json {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  const chat = resolveScheduleTarget(tokenSessionId, env.target);
  if (!chat.ok) return fail(`This chat cannot have scheduled prompts: ${chat.reason}`);
  const sessionId = chat.target.sessionId;

  if (name === SESSION_SCHEDULE_CREATE_TOOL) {
    let created: Schedule;
    try {
      created = createSessionSchedule({
        target_session_id: sessionId, cron_expr: args.cron, prompt: args.prompt, recurring: args.recurring,
        timezone: args.timezone, name: args.name,
      }, { deps: env.target, now: env.now() });
    } catch (e) {
      return fail(refusalText(e));
    }
    env.changed();
    return json({
      created: true,
      ...describe(created, env),
      note: "PPM stores this schedule: it survives restarts of PPM and of this chat. At each fire the prompt arrives in "
        + "this chat as a message, once the chat is idle. Delete it with session_schedule_delete and this id.",
    });
  }

  if (name === SESSION_SCHEDULE_LIST_TOOL) {
    const schedules = sessionSchedulesOf(sessionId, env.target);
    return json({ schedules: schedules.map((s) => describe(s, env)), count: schedules.length, max: MAX_SCHEDULES_PER_SESSION });
  }

  const id = typeof args.id === "number" ? args.id : typeof args.id === "string" && /^\d+$/.test(args.id) ? Number(args.id) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) return fail("`id` must be a schedule id from session_schedule_list.");
  const schedule = getSchedule(id);
  // Another chat's schedule reads exactly like one that does not exist: its id says nothing here.
  const own = schedule?.kind === "session" && sessionScheduleTargetIds(sessionId, env.target).includes(schedule.target_session_id ?? "");
  if (!schedule || !own) return fail(`This chat has no schedule with id ${id}; see session_schedule_list.`);
  deleteSchedule(id);
  env.changed();
  return json({ deleted: true, id, name: schedule.name, note: "It will not fire again." });
}
