import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { inQuietHours, minutesOfDay, type QuietHours } from "../../shared/assistant-quiet-hours.ts";
import { assistantClock } from "./assistant-clock.ts";

/**
 * Quiet hours as the Assistant's own schedules read them: whether the window is on now, and when
 * the current window began (what "per quiet window" counts from).
 */

/** Whether the user's quiet hours are on right now. */
export function quietNow(): boolean {
  const settings = getAssistantSettings();
  return inQuietHours(assistantClock.now(), settings.quiet_hours, settings.timezone);
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** When the quiet window `nowMs` falls in began (ms, to the minute); null outside one. */
export function quietWindowStart(nowMs: number, quiet: QuietHours, zone?: string): number | null {
  if (!inQuietHours(nowMs, quiet, zone)) return null;
  const elapsed = (minutesOfDay(nowMs, zone) - minutesOf(quiet.start) + 1440) % 1440;
  const minuteStart = nowMs - (nowMs % 60_000);
  return minuteStart - elapsed * 60_000;
}

/**
 * When the quiet window `nowMs` falls in ends (ms, to the minute); null outside one. A clock change
 * inside the window (summer time) is corrected for once, by reading the zone's own clock at the
 * first guess, so the end lands on the wall-clock time the user set.
 */
export function quietWindowEnd(nowMs: number, quiet: QuietHours, zone?: string): number | null {
  if (!inQuietHours(nowMs, quiet, zone)) return null;
  const end = minutesOf(quiet.end);
  const left = (end - minutesOfDay(nowMs, zone) + 1440) % 1440 || 1440;
  const guess = nowMs - (nowMs % 60_000) + left * 60_000;
  // Signed difference between the zone's clock at the guess and the end, in (-720, 720].
  const off = ((minutesOfDay(guess, zone) - end + 1440 + 720) % 1440) - 720;
  return guess - off * 60_000;
}

/** The current quiet window's end from Settings, or null outside quiet hours. */
export function currentQuietWindowEnd(): number | null {
  const settings = getAssistantSettings();
  return quietWindowEnd(assistantClock.now(), settings.quiet_hours, settings.timezone);
}

/** The current quiet window's start from Settings, or null outside quiet hours. */
export function currentQuietWindowStart(): number | null {
  const settings = getAssistantSettings();
  return quietWindowStart(assistantClock.now(), settings.quiet_hours, settings.timezone);
}
