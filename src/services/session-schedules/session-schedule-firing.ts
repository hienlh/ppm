/**
 * What the scheduler does when a session schedule's time comes: nothing runs here. The fire is
 * recorded as pending and handed to the deliverer, which sends it into the chat once the chat is
 * idle. Fires that pass before delivery coalesce into the one already pending.
 *
 * Unlike prompt and script schedules, a session schedule whose time passed while PPM was off is
 * delivered once when PPM starts: a reminder the user asked a chat for should not vanish because
 * the machine was asleep, and coalescing keeps a week offline from turning into a week of turns.
 */
import type { Schedule } from "../../types/scheduler.ts";
import { createLogger } from "../logger.ts";
import { getPendingSessionSchedules, setSessionSchedulePending, updateSchedule } from "../scheduler-db.service.ts";
import { followingFireAt, nextFireAt } from "../scheduler-timing.ts";
import { notifySessionScheduleDue } from "./session-schedule-due.ts";
import { broadcastSchedulesChanged } from "./session-schedules-changed.ts";

const log = createLogger("scheduler");

/** The fire after `from`, or null (with a warning) when the cron no longer parses. */
function safeFollowingFire(schedule: Schedule, from: Date): string | null {
  try {
    return followingFireAt(schedule, from);
  } catch (e) {
    log.warn(`invalid cron for schedule ${schedule.id} (${schedule.name}): ${(e as Error).message}`);
    return null;
  }
}

/** A due fire from the timer: pending at its scheduled time, next fire from now, deliverer told. */
export function markSessionScheduleDue(schedule: Schedule, now = new Date()): void {
  const since = schedule.next_fire_at ?? now.toISOString();
  try {
    setSessionSchedulePending(schedule.id, since, safeFollowingFire(schedule, now));
  } catch (e) {
    log.warn(`failed to record the fire of schedule ${schedule.id}: ${(e as Error).message}`);
    return;
  }
  log.info(`Schedule ${schedule.id} (${schedule.name}) came due for session ${schedule.target_session_id}`);
  broadcastSchedulesChanged();
  notifySessionScheduleDue(schedule.id);
}

/** A fire asked for by hand: pending now, the cron's own next fire left as it is. */
export function queueSessionScheduleNow(schedule: Schedule, now = new Date()): void {
  if (schedule.paused_reason) throw new Error(`This schedule is paused: ${schedule.paused_reason}`);
  setSessionSchedulePending(schedule.id, now.toISOString(), schedule.next_fire_at);
  log.info(`Schedule ${schedule.id} (${schedule.name}) queued by hand for session ${schedule.target_session_id}`);
  notifySessionScheduleDue(schedule.id);
}

/**
 * At start, before the timer is armed: a fire missed while PPM was off becomes one pending fire,
 * and the next fire is counted from now. A one-shot whose fire is already pending, or still
 * ahead, is left alone. A paused schedule is not touched; it is rescheduled when turned back on.
 */
export function catchUpSessionSchedule(schedule: Schedule, now = new Date()): void {
  if (schedule.paused_reason) return;
  try {
    if (schedule.next_fire_at && Date.parse(schedule.next_fire_at) <= now.getTime()) {
      setSessionSchedulePending(schedule.id, schedule.next_fire_at, safeFollowingFire(schedule, now));
      log.info(`Schedule ${schedule.id} (${schedule.name}) came due while PPM was off; it is delivered once`);
    } else if (schedule.recurring) {
      updateSchedule(schedule.id, { next_fire_at: nextFireAt(schedule.cron_expr, schedule.timezone, now) });
    }
  } catch (e) {
    log.warn(`failed to reschedule schedule ${schedule.id} (${schedule.name}): ${(e as Error).message}`);
  }
}

/** Hand every fire still pending to the deliverer: a pending fire outlives a restart. */
export function handOverPendingSessionSchedules(): void {
  let pending: Schedule[];
  try {
    pending = getPendingSessionSchedules();
  } catch (e) {
    log.warn(`could not read pending session schedules: ${(e as Error).message}`);
    return;
  }
  for (const s of pending) notifySessionScheduleDue(s.id);
}
