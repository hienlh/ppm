/**
 * What the user is told when a chat's AI schedules a prompt into that chat. The AI may do that
 * without asking, so the notification is how the user learns a timer now exists: which schedule,
 * in which chat, when it runs, and what it will say. Only the AI's tool sends it; a schedule saved
 * from Settings, the REST route or the CLI was made by the user, who needs no telling.
 */
import { describeCron } from "../../shared/cron-in-words.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { NotificationPayload } from "../notification.service.ts";
import type { ScheduleTarget } from "../session-schedules/session-schedule-target.ts";

/** How much of the prompt the notification quotes: enough to recognise it, one line. */
export const PROMPT_SUMMARY_MAX = 120;

/** `2026-11-17 Mon 09:00` in `zone`: the wall clock the user reads the schedule by. */
export function wallClock(iso: string, zone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`;
}

/** The prompt on one line, cut to {@link PROMPT_SUMMARY_MAX} characters with an ellipsis. */
export function promptSummary(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length <= PROMPT_SUMMARY_MAX ? line : `${line.slice(0, PROMPT_SUMMARY_MAX - 1).trimEnd()}…`;
}

/**
 * The notification for `schedule`, which the AI of `chat` just created. `localZone` is the zone a
 * schedule without one is read in (the PPM host's). The payload names the chat's project, id and
 * provider, so the notification's link opens that chat.
 */
export function aiCreatedScheduleNotice(schedule: Schedule, chat: ScheduleTarget, chatTitle: string, localZone: string): NotificationPayload {
  const zone = schedule.timezone ?? localZone;
  const next = schedule.next_fire_at ? wallClock(schedule.next_fire_at, zone) : null;
  const when = schedule.recurring === 1
    ? `${describeCron(schedule.cron_expr)} (${zone})${next ? `, next run ${next}` : ""}`
    : next ? `Runs once, at ${next} (${zone})` : `Runs once, at the next match of ${schedule.cron_expr} (${zone})`;
  return {
    title: `AI scheduled a prompt: ${schedule.name}`,
    body: `In ${chatTitle} (${chat.projectName}). ${when}.`,
    detail: promptSummary(schedule.prompt),
    detailStyle: "quote",
    project: chat.projectName,
    sessionId: chat.sessionId,
    providerId: chat.providerId,
  };
}
