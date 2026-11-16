/**
 * Today's date (`YYYY-MM-DD`) in the user's time zone, for due-date urgency. The user's zone is the
 * one set in Settings → PPM Assistant, else the one the last browser reported, else the host's:
 * PPM often runs on a machine in another country from its user.
 */
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { isValidTimeZone, lastClientTimeZone } from "../client-timezone.ts";

/** The zone due dates are read in. Never throws. */
export function userTimeZone(): string | undefined {
  try {
    const configured = getAssistantSettings().timezone;
    if (configured && isValidTimeZone(configured)) return configured;
  } catch { /* settings unreadable: fall through */ }
  return lastClientTimeZone()?.timeZone;
}

/** `YYYY-MM-DD` of `now` in `timeZone` (the host's when absent or unknown). */
export function ymdInZone(now: number, timeZone?: string): string {
  const format = (tz?: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format(undefined);
  }
}

export function todayYmd(now: number = Date.now()): string {
  return ymdInZone(now, userTimeZone());
}
