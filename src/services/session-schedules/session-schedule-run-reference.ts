/**
 * What the model is told about a session schedule's run: which schedule, when it came due, when PPM
 * sent it, and whether it went out late or stands for several fires. The block itself is written by
 * the chat socket (`chat-schedule-run.ts`); this only fills it in from the stored schedule.
 */
import { normalizeScheduleRunText, type ScheduleRunReference } from "../../shared/chat-schedule-run.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { followingFireAt } from "../scheduler-timing.ts";

/** Sent more than this after it came due counts as late: PPM was off, or the chat was busy. */
export const LATE_AFTER_MS = 60_000;

/** The fire after `from`, or null when there is none or the cron no longer parses. */
function safeFollowing(schedule: Schedule, from: Date): string | null {
  try {
    return followingFireAt(schedule, from);
  } catch {
    return null;
  }
}

/** The run reference for `schedule`'s pending fire, sent at `now`. */
export function scheduleRunReference(schedule: Schedule, now: number): ScheduleRunReference {
  const due = schedule.pending_since && Number.isFinite(Date.parse(schedule.pending_since))
    ? Date.parse(schedule.pending_since)
    : now;
  const following = safeFollowing(schedule, new Date(due));
  return {
    version: 1,
    scheduleId: schedule.id,
    // Normalized here as well as on save: a row stored before names were normalized may still hold
    // a tab, a newline or a double space, which the chat's check on the block refuses.
    name: normalizeScheduleRunText(schedule.name) || `Schedule ${schedule.id}`,
    cron: normalizeScheduleRunText(schedule.cron_expr),
    timezone: schedule.timezone,
    scheduledFor: new Date(due).toISOString(),
    firedAt: new Date(now).toISOString(),
    catchUp: now - due > LATE_AFTER_MS,
    // A later fire already due before this one went out was folded into it, not queued after it.
    coalesced: following !== null && Date.parse(following) <= now,
  };
}
