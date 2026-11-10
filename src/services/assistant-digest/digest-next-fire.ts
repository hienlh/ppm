import { isTimeZone } from "../../shared/assistant-quiet-hours.ts";

/**
 * When the morning digest fires: the next "HH:MM" on the wall clock of an IANA zone (the zone the
 * user's browser saved with the time, else the server's own). Pure, so the clock and the zone are
 * arguments and a table of cases tests it; the service arms one timer with the result instead of
 * checking the time every minute.
 *
 * A wall-clock time is turned into an instant by reading the zone's offset twice: once at the
 * naive UTC reading of that time, once at the first guess. That lands on the right instant on
 * either side of a clock change. A time the clock skips (01:30 on a spring-forward night) becomes
 * the instant an hour later, which is the first moment the clock shows a later time.
 */

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = PARTS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    PARTS.set(zone, f);
  }
  return f;
}

interface WallClock { y: number; m: number; d: number; h: number; mi: number; s: number }

function wallClock(ms: number, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** The server's own zone, which applies when the user never saved one. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The zone to use: the saved one when this runtime knows it, else the server's. */
export function digestZone(saved: string | undefined): string {
  return saved && isTimeZone(saved) ? saved : serverTimeZone();
}

/** How far the zone's clock is ahead of UTC at `ms`. */
function offsetAt(ms: number, zone: string): number {
  const w = wallClock(ms, zone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The zone's calendar date at `ms`, as "YYYY-MM-DD". */
export function localDate(ms: number, zone: string): string {
  const w = wallClock(ms, zone);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** `date` moved by `days` on the calendar. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The instant the zone's clock reads `hhmm` on `date`. */
export function instantOf(date: string, hhmm: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, h!, mi!);
  const guess = naive - offsetAt(naive, zone);
  return naive - offsetAt(guess, zone);
}

export interface DigestFire {
  /** The user's date the digest belongs to. */
  date: string;
  at: number;
}

/** The next fire strictly after `now`. */
export function nextDigestFire(now: number, hhmm: string, zone: string): DigestFire {
  const today = localDate(now, zone);
  const at = instantOf(today, hhmm, zone);
  if (at > now) return { date: today, at };
  const tomorrow = addDays(today, 1);
  return { date: tomorrow, at: instantOf(tomorrow, hhmm, zone) };
}

/** The latest fire at or before `now`: what a PPM that was off at the time may still owe. */
export function lastDigestFire(now: number, hhmm: string, zone: string): DigestFire {
  const today = localDate(now, zone);
  const at = instantOf(today, hhmm, zone);
  if (at <= now) return { date: today, at };
  const yesterday = addDays(today, -1);
  return { date: yesterday, at: instantOf(yesterday, hhmm, zone) };
}
