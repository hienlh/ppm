/**
 * How a session schedule reads to a person, without React: its cron in words, a time in the
 * schedule's own zone, and what it is doing now. Shared by the chat's schedule chip, the
 * schedule-run line in the transcript and Settings → Schedules, so the three never disagree.
 */
import type { ScheduleView } from "../../types/scheduler";

export { describeCron } from "../../shared/cron-in-words";

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

/** What a session schedule is doing: active, waiting for its chat (or held after a Stop), paused (and why), or off. */
export function sessionScheduleStatus(
  s: Pick<ScheduleView, "enabled" | "paused_reason" | "pending_since" | "timezone" | "held_after_stop">,
): SessionScheduleStatus {
  if (s.paused_reason) return { text: "Paused", tone: "bad", detail: s.paused_reason };
  if (!s.enabled) return { text: "Off", tone: "off" };
  if (s.pending_since && s.held_after_stop) {
    return {
      text: "Held after Stop",
      tone: "wait",
      detail: `Due since ${formatInZone(s.pending_since, s.timezone)}; held after Stop until the chat's next turn ends or the next fire.`,
    };
  }
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
