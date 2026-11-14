/**
 * Saving a session schedule, one way for every door: the REST routes, the CLI when no server holds
 * the database, and the AI's own schedule tool. The fields are checked by the shared rules
 * (`session-schedule-input.ts`) and the chat by the lifecycle's (`assertCanAddSessionSchedule`), so
 * a schedule one door accepts is never one another would refuse.
 *
 * Bodies are spelled as the REST route spells them (`cron_expr`, `target_session_id`); the
 * project, provider and permission mode come from the chat, never from the body.
 */
import { DEFAULT_TIMEOUT_MS } from "../../shared/schedule-definition.ts";
import { validateSessionScheduleInput } from "../../shared/session-schedule-input.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { getSchedule, insertSchedule, listSessionSchedulesForTarget, updateSchedule } from "../scheduler-db.service.ts";
import { ScheduleEditError } from "../scheduler-edit.ts";
import { nextFireAt } from "../scheduler-timing.ts";
import { notifySessionScheduleDue } from "./session-schedule-due.ts";
import { assertCanAddSessionSchedule, resumeSessionSchedule, sessionScheduleTargetIds } from "./session-schedule-lifecycle.ts";
import { liveScheduleTargetDeps, type ScheduleTargetDeps } from "./session-schedule-target.ts";

type Body = Record<string, unknown>;

export interface SessionScheduleSaveOptions {
  deps?: ScheduleTargetDeps;
  now?: Date;
}

/** Create a session schedule from a route-spelled body. Throws `ScheduleEditError` or `SessionScheduleRefusal`. */
export function createSessionSchedule(body: Body, { deps = liveScheduleTargetDeps, now = new Date() }: SessionScheduleSaveOptions = {}): Schedule {
  const check = validateSessionScheduleInput({
    targetSessionId: body.target_session_id, name: body.name, prompt: body.prompt, cron: body.cron_expr,
    timezone: body.timezone, recurring: body.recurring,
  });
  if (!check.ok) throw new ScheduleEditError(check.errors);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new ScheduleEditError(["enabled must be true or false"]);
  const input = check.value;
  // Checked last: a body with bad fields is answered with all of them before the chat is looked at.
  const target = assertCanAddSessionSchedule(input.targetSessionId, deps);
  const id = insertSchedule({
    kind: "session",
    name: input.name,
    cron_expr: input.cron,
    prompt: input.prompt,
    timezone: input.timezone,
    recurring: input.recurring,
    target_session_id: target.sessionId,
    project_path: target.projectPath,
    provider_id: target.providerId,
    timeout_ms: DEFAULT_TIMEOUT_MS.session,
    enabled: body.enabled !== false,
    next_fire_at: nextFireAt(input.cron, input.timezone, now),
  });
  return getSchedule(id)!;
}

/**
 * Apply a PATCH body to a session schedule and answer it as stored. Its chat cannot change (a
 * schedule for another chat is a new schedule); a body turning it on clears a pause, which is
 * refused while the chat still cannot take it.
 */
export function patchSessionSchedule(current: Schedule, body: Body, { deps = liveScheduleTargetDeps, now = new Date() }: SessionScheduleSaveOptions = {}): Schedule {
  const problems: string[] = [];
  if (body.kind !== undefined && body.kind !== current.kind) problems.push("A schedule's kind cannot change; create a new schedule instead");
  if (body.target_session_id !== undefined && body.target_session_id !== current.target_session_id) {
    problems.push("A session schedule's chat cannot change; create a schedule in the other chat instead");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") problems.push("enabled must be true or false");
  const merged = {
    targetSessionId: current.target_session_id,
    name: body.name !== undefined ? body.name : current.name,
    prompt: body.prompt !== undefined ? body.prompt : current.prompt,
    cron: body.cron_expr !== undefined ? body.cron_expr : current.cron_expr,
    timezone: body.timezone !== undefined ? body.timezone : current.timezone,
    recurring: body.recurring !== undefined ? body.recurring : current.recurring === 1,
  };
  const check = validateSessionScheduleInput(merged);
  if (!check.ok) problems.push(...check.errors);
  if (problems.length || !check.ok) throw new ScheduleEditError(problems);

  const v = check.value;
  const changes: Partial<Schedule> = {};
  if (body.name !== undefined) changes.name = v.name;
  if (body.prompt !== undefined) changes.prompt = v.prompt;
  if (body.cron_expr !== undefined) changes.cron_expr = v.cron;
  if (body.timezone !== undefined) changes.timezone = v.timezone;
  if (body.recurring !== undefined) changes.recurring = v.recurring ? 1 : 0;
  const enabling = body.enabled === true && !current.enabled;
  if (body.enabled !== undefined) changes.enabled = body.enabled ? 1 : 0;
  const retimed = body.cron_expr !== undefined || body.timezone !== undefined || body.recurring !== undefined;
  if (retimed || enabling) changes.next_fire_at = nextFireAt(v.cron, v.timezone, now);

  // Turned on while paused: resumed first, so a chat that still cannot take it leaves it unchanged.
  if (body.enabled === true && current.paused_reason !== null) resumeSessionSchedule(current.id, now, deps);
  updateSchedule(current.id, changes);
  const saved = getSchedule(current.id)!;
  // Turned off with a fire still waiting (the chip's Pause), then on again: that fire goes now,
  // rather than at the next cron match, which for a one-shot may be a year away.
  if (enabling && saved.pending_since && !saved.paused_reason) notifySessionScheduleDue(saved.id);
  return saved;
}

/** Every session schedule aimed at the chat `sessionId` names, under any id it had, oldest first. */
export function sessionSchedulesOf(sessionId: string, deps: Pick<ScheduleTargetDeps, "canonical"> = liveScheduleTargetDeps): Schedule[] {
  return sessionScheduleTargetIds(sessionId, deps)
    .flatMap((id) => listSessionSchedulesForTarget(id))
    .sort((a, b) => a.id - b.id);
}
