/**
 * Quiet hours for PPM Assistant: a daily window, in the user's own time zone, in which nothing PPM
 * started on its own reaches a manager chat (and, later, the user's phone). Shared by the server,
 * which enforces it, and the settings pane, which edits it.
 *
 * The zone is the IANA name the browser reported when the user saved the window; with none, the
 * server's own zone applies.
 */

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: "22:00", end: "07:00" };

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ZONE = 64;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether `text` is a 24-hour "HH:MM" time. */
export function isClockTime(text: unknown): text is string {
  return typeof text === "string" && HHMM_RE.test(text);
}

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  if (!zone || zone.length > MAX_ZONE) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Stored or sent quiet hours, checked; problems are listed and the defaults kept for them. */
export function readQuietHours(raw: unknown, errors: string[]): QuietHours {
  if (raw === undefined || raw === null) return { ...DEFAULT_QUIET_HOURS };
  if (!isRecord(raw)) {
    errors.push("quiet_hours must be an object");
    return { ...DEFAULT_QUIET_HOURS };
  }
  const out = { ...DEFAULT_QUIET_HOURS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    else errors.push("quiet_hours.enabled must be true or false");
  }
  for (const key of ["start", "end"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === "string" && HHMM_RE.test(raw[key] as string)) out[key] = raw[key] as string;
    else errors.push(`quiet_hours.${key} must be a time as HH:MM`);
  }
  return out;
}

/** A stored or sent time zone, or undefined for "the server's own". */
export function readTimeZone(raw: unknown, errors: string[]): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && isTimeZone(raw)) return raw;
  errors.push("timezone must be an IANA time zone name");
  return undefined;
}

/** Minutes since midnight of `nowMs` in `zone` (the server's zone when absent or unknown). */
export function minutesOfDay(nowMs: number, zone?: string): number {
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", zone ? { ...options, timeZone: zone } : options).formatToParts(nowMs);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(nowMs);
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

const toMinutes = (hhmm: string): number => {
  const m = HHMM_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

/**
 * Whether `nowMs` falls inside the window. Start is inside, end is not; a window whose end is
 * earlier than its start runs past midnight; a window that starts and ends at the same minute is
 * empty.
 */
export function inQuietHours(nowMs: number, quiet: QuietHours, zone?: string): boolean {
  if (!quiet.enabled) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const now = minutesOfDay(nowMs, zone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}
