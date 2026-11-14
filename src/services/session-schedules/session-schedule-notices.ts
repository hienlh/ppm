/**
 * What the user is told about session schedules that cannot go out: one waiting behind a card,
 * one that failed and will be tried again, and schedules paused until someone turns them back on.
 */
import type { Schedule } from "../../types/scheduler.ts";
import type { NoticeChat, ScheduleNotice } from "./session-schedule-dispatch-types.ts";

const quoted = (schedules: readonly Schedule[]): string => schedules.map((s) => `"${s.name}"`).join(", ");

/** The schedule waits behind a card already on the chat's screen. */
export function heldUpNotice(schedule: Schedule, chat: NoticeChat, chatTitle: string, stillRelevant: () => boolean): ScheduleNotice {
  return {
    kind: "waiting", key: `waiting:${schedule.id}`, schedules: [schedule], ...chat, stillRelevant,
    title: "Schedule is waiting",
    body: `Schedule ${schedule.name} is waiting: an approval is pending in ${chatTitle}`,
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
