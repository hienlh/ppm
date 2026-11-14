/**
 * How a session schedule reads to a person, without React: its cron in words, a time in the
 * schedule's own zone, and what it is doing now. Shared by the chat's schedule chip, the
 * schedule-run line in the transcript and Settings → Schedules, so the three never disagree.
 */
import type { ScheduleView } from "../../types/scheduler";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INT = /^\d+$/;

const pad = (n: string) => n.padStart(2, "0");

/** "1-5" or "1,3,5" as weekday names; null when the field is not a plain list or range of days. */
function weekdayText(field: string): string | null {
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0") return "weekends";
  const days: string[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to || to > 7) return null;
      days.push(`${WEEKDAYS[from % 7]}–${WEEKDAYS[to % 7]}`);
    } else if (/^\d$/.test(part) && Number(part) <= 7) {
      days.push(WEEKDAYS[Number(part) % 7]!);
    } else return null;
  }
  return days.join(", ");
}

/**
 * A 5-field cron in words for the common shapes ("Daily at 08:00", "Every 15 minutes"); the
 * expression itself for anything else, which is never wrong, only less friendly.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min === "*") return "Every minute";
    const every = /^\*\/(\d+)$/.exec(min);
    if (every) return `Every ${every[1]} minutes`;
    if (INT.test(min)) return `Hourly at :${pad(min)}`;
    return expr;
  }
  if (!INT.test(min) || !INT.test(hour)) return expr;
  const at = `${pad(hour)}:${pad(min)}`;
  if (dom === "*" && mon === "*") {
    if (dow === "*") return `Daily at ${at}`;
    const days = weekdayText(dow);
    return days ? `${days[0]!.toUpperCase()}${days.slice(1)} at ${at}` : expr;
  }
  if (dow !== "*" || !INT.test(dom)) return expr;
  if (mon === "*") return `Monthly on day ${dom} at ${at}`;
  if (INT.test(mon) && Number(mon) >= 1 && Number(mon) <= 12) return `${MONTHS[Number(mon) - 1]} ${dom} at ${at}`;
  return expr;
}

/** "Europe/London" → "London", "America/Argentina/Buenos_Aires" → "Buenos Aires"; "UTC" stays. */
export function zoneCity(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** The calendar day `date` falls on in `zone` (or the device's zone), for "is it today there". */
function dayIn(date: Date, zone: string | null): string {
  return date.toLocaleDateString("en-CA", zone ? { timeZone: zone } : undefined);
}

/**
 * `iso` as a clock time in `zone` — with the date in front when it is not today there — and the
 * zone's city after it. With no zone it is the device's own time, which needs no label.
 */
export function formatInZone(iso: string, zone: string | null, now = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  let text: string;
  try {
    const sameDay = dayIn(date, zone) === dayIn(now, zone);
    text = date.toLocaleString(undefined, {
      ...(zone && { timeZone: zone }),
      ...(!sameDay && { month: "short", day: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // A zone this browser does not know: the device's time, still labelled with the zone.
    text = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return zone ? `${text} (${zoneCity(zone)})` : text;
}

export type SessionScheduleTone = "ok" | "wait" | "bad" | "off";

export interface SessionScheduleStatus {
  text: string;
  tone: SessionScheduleTone;
  /** A sentence saying why, for a paused or waiting schedule. */
  detail?: string;
}

/** What a session schedule is doing: active, waiting for its chat, paused (and why), or off. */
export function sessionScheduleStatus(s: Pick<ScheduleView, "enabled" | "paused_reason" | "pending_since" | "timezone">): SessionScheduleStatus {
  if (s.paused_reason) return { text: "Paused", tone: "bad", detail: s.paused_reason };
  if (!s.enabled) return { text: "Off", tone: "off" };
  if (s.pending_since) {
    return {
      text: "Waiting for the chat",
      tone: "wait",
      detail: `Due since ${formatInZone(s.pending_since, s.timezone)}; it is sent once the chat is idle.`,
    };
  }
  return { text: "Active", tone: "ok" };
}

/** A schedule worth a glance: paused by PPM, or due and still waiting for its chat. */
export function needsAttention(s: Pick<ScheduleView, "paused_reason" | "pending_since" | "enabled">): boolean {
  return !!s.paused_reason || (!!s.enabled && !!s.pending_since);
}

/** "Next: Nov 15, 08:00 (London)", or why there is none. */
export function nextRunText(s: Pick<ScheduleView, "enabled" | "next_fire_at" | "timezone" | "pending_since" | "paused_reason">, now = new Date()): string {
  if (!s.enabled || s.paused_reason) return "Not scheduled";
  if (!s.next_fire_at) return s.pending_since ? "Due now" : "No next run";
  return `Next: ${formatInZone(s.next_fire_at, s.timezone, now)}`;
}
