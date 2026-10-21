import { SHARE_LIMITS } from "../../../shared/design-share-types";

/**
 * The expiry a share link is given: a preset, never, or the end of a chosen day in local
 * time. Pure, so the arithmetic is tested without a browser.
 *
 * The server checks the same bound against its own clock (after now, at most
 * {@link SHARE_LIMITS.maxExpiryMs} ahead), so a custom day is capped to the last one whose
 * end still falls inside it.
 */

export type ShareExpiryPreset = "1d" | "7d" | "30d" | "never" | "custom";

export const SHARE_EXPIRY_PRESETS: { id: ShareExpiryPreset; label: string }[] = [
  { id: "1d", label: "1 day" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "never", label: "Never" },
  { id: "custom", label: "Custom" },
];

export const DEFAULT_SHARE_EXPIRY: ShareExpiryPreset = "7d";

const DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_DAYS: Partial<Record<ShareExpiryPreset, number>> = { "1d": 1, "7d": 7, "30d": 30 };

export interface ShareExpiryChoice {
  preset: ShareExpiryPreset;
  /** `YYYY-MM-DD`, read only for `custom`. */
  customDate: string;
}

export type ShareExpiryResult = { ok: true; expiresAt: number | null } | { ok: false; error: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** A local date as the `YYYY-MM-DD` an `<input type="date">` takes. */
export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last millisecond of a `YYYY-MM-DD` day in local time, or null for a malformed date. */
export function endOfLocalDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const end = new Date(y, mo, d, 23, 59, 59, 999);
  // `new Date` rolls 2026-02-31 over into March; a date that moved was never a real day.
  if (end.getFullYear() !== y || end.getMonth() !== mo || end.getDate() !== d) return null;
  return end.getTime();
}

/** Earliest day the date input offers: today, whose end is still ahead. */
export function minCustomDate(now: number): string {
  return toDateInputValue(now);
}

/** Latest day whose end is still at most a year ahead. */
export function maxCustomDate(now: number): string {
  const limit = now + SHARE_LIMITS.maxExpiryMs;
  const sameDay = toDateInputValue(limit);
  const end = endOfLocalDay(sameDay);
  return end !== null && end <= limit ? sameDay : toDateInputValue(limit - DAY_MS);
}

/** The `expiresAt` to send for a choice, or why it cannot be sent. */
export function expiryFromChoice(choice: ShareExpiryChoice, now: number): ShareExpiryResult {
  if (choice.preset === "never") return { ok: true, expiresAt: null };
  const days = PRESET_DAYS[choice.preset];
  if (days) return { ok: true, expiresAt: now + days * DAY_MS };
  const end = endOfLocalDay(choice.customDate);
  if (end === null) return { ok: false, error: "Pick a date" };
  if (end <= now) return { ok: false, error: "Pick a date that is still ahead" };
  if (end > now + SHARE_LIMITS.maxExpiryMs) return { ok: false, error: "A link can stay open for at most a year" };
  return { ok: true, expiresAt: end };
}

/** What the Change expiry control starts at for a link: never, or its own day. */
export function choiceForExpiry(expiresAt: number | null, now: number): ShareExpiryChoice {
  if (expiresAt === null) return { preset: "never", customDate: toDateInputValue(now + 7 * DAY_MS) };
  return { preset: "custom", customDate: toDateInputValue(Math.max(expiresAt, now)) };
}

/** "Expires in 3 days", "Expires in 5 hours"…, or null for a link that never expires. */
export function expiresInLabel(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null;
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  // Rounded, not floored: a 7-day link read a moment after it was made still says 7 days.
  if (left < 60 * 60 * 1000) return "Expires in under an hour";
  const hours = Math.round(left / (60 * 60 * 1000));
  if (hours < 24) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(left / DAY_MS);
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}
