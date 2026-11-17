/**
 * Snoozing a task: hiding it from the daily lists until a date, or until one of its Jira or PR
 * links changes. The task keeps its real status; only the snooze fields say it is out of sight.
 * Whether a snooze still holds is worked out when a list is read (like effective urgency), so a
 * task is back on its date even before PPM's sweep records that it came back. Shared by the
 * server, the AI tools and the browser.
 */
import { daysBetween } from "./ppm-tasks-urgency.ts";

/** Why a snoozed task came back. */
export type ResurfaceReason = "date" | "link";

export interface SnoozeFields {
  /** `YYYY-MM-DD`: the day the task shows again. */
  snoozedUntil: string | null;
  /** Hidden until one of its Jira or PR links changes. */
  snoozeUntilChange: boolean;
  /** When the current snooze was set (a link change after this wakes it). */
  snoozedAt: number | null;
}

/** Whether the task has a snooze set at all (whether or not it has run out). */
export const hasSnooze = (t: Pick<SnoozeFields, "snoozedUntil" | "snoozeUntilChange">): boolean =>
  t.snoozedUntil !== null || t.snoozeUntilChange;

/**
 * Why a set snooze has run out, or null while it still holds. `lastLinkChangeAt` is the newest
 * time any of the task's Jira or PR links changed (null when none ever did).
 */
export function snoozeWakeReason(t: SnoozeFields, todayYmd: string, lastLinkChangeAt: number | null): ResurfaceReason | null {
  if (!hasSnooze(t)) return null;
  if (t.snoozedUntil !== null) {
    const days = daysBetween(todayYmd, t.snoozedUntil);
    if (days === null || days <= 0) return "date";
  }
  if (t.snoozeUntilChange && lastLinkChangeAt !== null && lastLinkChangeAt > (t.snoozedAt ?? 0)) return "link";
  return null;
}

/** Whether the task is out of sight right now. */
export const isSnoozedNow = (t: SnoozeFields, todayYmd: string, lastLinkChangeAt: number | null): boolean =>
  hasSnooze(t) && snoozeWakeReason(t, todayYmd, lastLinkChangeAt) === null;

/** `ymd` moved by `days` (calendar days, no time zone involved). */
export function addDaysYmd(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + days));
  return d.toISOString().slice(0, 10);
}

/** The quick choices: tomorrow, a week from today. */
export const snoozeTomorrow = (todayYmd: string): string => addDaysYmd(todayYmd, 1);
export const snoozeOneWeek = (todayYmd: string): string => addDaysYmd(todayYmd, 7);

/** Whether a task's links include one whose change can wake it (Jira or PR). */
export const hasWatchableLink = (links: ReadonlyArray<{ kind: string }>): boolean =>
  links.some((l) => l.kind === "jira" || l.kind === "pr");

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 20 Nov" (the year only when it is not this year's). */
export function shortDay(ymd: string, todayYmd?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  const sameYear = !todayYmd || todayYmd.slice(0, 4) === m[1];
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}${sameYear ? "" : ` ${m[1]}`}`;
}

/** "until Thu 20 Nov", "until a link changes", "until Thu 20 Nov or a link changes"; null when not snoozed. */
export function snoozeText(t: Pick<SnoozeFields, "snoozedUntil" | "snoozeUntilChange">, todayYmd?: string): string | null {
  if (!hasSnooze(t)) return null;
  const parts = [t.snoozedUntil ? shortDay(t.snoozedUntil, todayYmd) : null, t.snoozeUntilChange ? "a link changes" : null].filter(Boolean);
  return `until ${parts.join(" or ")}`;
}
