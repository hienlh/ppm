/**
 * What the user is told about session schedules that cannot go out: one waiting behind a card,
 * one that failed and will be tried again, and schedules paused until someone turns them back on.
 */
import type { Schedule } from "../../types/scheduler.ts";
import type { NoticeChat, ScheduleNotice } from "./session-schedule-dispatch-types.ts";
import { describeWait } from "./session-schedule-retry-backoff.ts";

const quoted = (schedules: readonly Schedule[]): string => schedules.map((s) => `"${s.name}"`).join(", ");

/** The schedule waits behind a card already on the chat's screen. */
export function heldUpNotice(schedule: Schedule, chat: NoticeChat, chatTitle: string, stillRelevant: () => boolean): ScheduleNotice {
  return {
    kind: "waiting", key: `waiting:${schedule.id}`, schedules: [schedule], ...chat, stillRelevant,
    title: "Schedule is waiting",
    body: `Schedule ${schedule.name} is waiting: an approval is pending in ${chatTitle}`,
  };
}

/** A one-shot's turn failed before it ran; its fire stays pending and goes again after `delayMs`. */
export function retryingNotice(schedule: Schedule, chat: NoticeChat, reason: string, delayMs: number): ScheduleNotice {
  return {
    kind: "retrying", key: `retrying:${schedule.id}`, schedules: [schedule], ...chat,
    title: `Schedule did not run: ${schedule.name}`,
    body: `${reason} PPM will send it again in ${describeWait(delayMs)}.`,
  };
}

/**
 * The schedule's turn failed after it had started working (written an answer, called a tool), so
 * it is not sent again: a one-shot is paused until someone turns it back on, a recurring one runs
 * again at its next time.
 */
export function failedPartwayNotice(schedule: Schedule, chat: NoticeChat, why: string): ScheduleNotice {
  const after = schedule.recurring
    ? "It runs again at its next time."
    : "It is paused; turn it back on to run it again.";
  return {
    kind: "failed", key: `failed:${schedule.id}`, schedules: [schedule], ...chat,
    title: `Schedule failed partway: ${schedule.name}`,
    body: `Its turn failed after it had started working: ${why}. PPM did not send it again, so nothing it did runs twice. ${after}`,
  };
}

/**
 * Schedules that stopped firing until they are turned back on. Several paused at once for one
 * chat (it was deleted while they waited) are one notice, not one each.
 */
export function pausedNotice(schedules: readonly Schedule[], chat: NoticeChat, reason: string): ScheduleNotice {
  const one = schedules.length === 1;
  return {
    kind: "paused", key: one ? `paused:${schedules[0]!.id}` : `paused-chat:${chat.sessionId}`, schedules: [...schedules], ...chat,
    title: one ? `Schedule paused: ${schedules[0]!.name}` : `${schedules.length} schedules paused`,
    body: one
      ? `${reason} Turn it back on once the chat can take it again.`
      : `${reason} Paused: ${quoted(schedules)}. Turn them back on once the chat can take them again.`,
  };
}
