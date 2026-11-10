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
 * When the quiet window `nowMs` falls in ends (ms, to the minute); null outside one. Counted in
 * wall-clock minutes of the zone, so a clock change inside the window can move the real end by its
 * size; whoever waits for it checks again when it comes.
 */
export function quietWindowEnd(nowMs: number, quiet: QuietHours, zone?: string): number | null {
  if (!inQuietHours(nowMs, quiet, zone)) return null;
  const left = (minutesOf(quiet.end) - minutesOfDay(nowMs, zone) + 1440) % 1440 || 1440;
  const minuteStart = nowMs - (nowMs % 60_000);
  return minuteStart + left * 60_000;
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
