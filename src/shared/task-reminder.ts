/**
 * A task's "Remind…" as the task page and the server both spell it. A reminder is a one-shot
 * session schedule the task owns (`schedules.task_id`): its cron pins minute, hour, day and month,
 * read in the reminder's own time zone, and it fires once at the next match — so it can be set at
 * most a year ahead, which is what the check below enforces.
 */
import { formatTaskRef } from "./ppm-tasks-refs.ts";

/** Longest note a reminder carries. */
export const REMINDER_NOTE_MAX = 500;
/** Furthest ahead a reminder can be: the cron has no year, so anything later would fire early. */
export const REMINDER_MAX_AHEAD_MS = 364 * 24 * 60 * 60_000;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface LocalMoment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** `2026-11-17T18:30` as its parts; null for anything else (or a date that does not exist). */
export function parseLocalMoment(text: unknown): LocalMoment | null {
  if (typeof text !== "string") return null;
  const m = LOCAL.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return { year, month, day, hour, minute };
}

/** The one-shot cron for a moment: `30 18 17 11 *`. */
export function reminderCron(at: LocalMoment): string {
  return `${at.minute} ${at.hour} ${at.day} ${at.month} *`;
}

/** `2026-11-17T18:30` for `date` as the clock in `timeZone` reads it (the device's when absent). */
export function localMomentText(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * The instant `at` names on the clock of `timeZone`. Two passes of "what does the zone read at my
 * guess" settle it, DST included; a time a spring-forward skips lands on the hour after it.
 */
export function localMomentToEpoch(at: LocalMoment, timeZone: string): number {
  const wall = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const read = parseLocalMoment(localMomentText(new Date(guess), timeZone))!;
    const readWall = Date.UTC(read.year, read.month - 1, read.day, read.hour, read.minute);
    guess += wall - readWall;
  }
  return guess;
}

/** The schedule's name in lists: `Remind: ppm/19 Review PR #412`, cut to `max`. */
export function reminderName(task: { number: number; project: string; title: string }, max = 100): string {
  const name = `Remind: ${formatTaskRef(task.number, task.project)} ${task.title}`;
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** What arrives in the chat when the reminder fires. It stands on its own: the chat may have moved on. */
export function reminderPrompt(task: { number: number; project: string; title: string }, note: string | null): string {
  const ref = formatTaskRef(task.number, task.project);
  const lines = [
    `Reminder for task ${ref} "${task.title}", set on the task page.`,
    ...(note ? [`Note: ${note}`] : []),
    `Look at where ${ref} stands now (ppm_task_get) and tell the user what needs doing.`,
  ];
  return lines.join("\n");
}

export interface ReminderChoice {
  id: "hour" | "evening" | "morning";
  label: string;
  /** `2026-11-17T18:30` on the chosen zone's clock. */
  at: string;
}

/**
 * The quick choices of the task page's Remind… menu, on the clock of `zone`: in an hour (rounded
 * up to five minutes), this evening at 18:00 while it is before 17:00 there, and tomorrow at 09:00.
 */
export function reminderChoices(now: Date, zone: string): ReminderChoice[] {
  const inHour = new Date(Math.ceil((now.getTime() + 60 * 60_000) / 300_000) * 300_000);
  const today = localMomentText(now, zone);
  const [y, m, d] = today.slice(0, 10).split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const hourThere = Number(today.slice(11, 13));
  return [
    { id: "hour", label: "In 1 hour", at: localMomentText(inHour, zone) },
    ...(hourThere < 17 ? [{ id: "evening" as const, label: "This evening", at: `${today.slice(0, 10)}T18:00` }] : []),
    { id: "morning", label: "Tomorrow morning", at: `${tomorrow}T09:00` },
  ];
}
