/**
 * Formatting and colour rules for account usage, shared by the Settings pane and the chat
 * usage chip.
 *
 * Extracted so both presentations agree: a bucket that reads 91% red in one place must not
 * read amber in the other, and "expires in" must not drift between them either.
 */

import type { LimitBucket } from "../../../../types/chat";
import type { AccountInfo } from "../../../lib/api-settings";

/** Text colour for a utilisation percentage. Thresholds are shared, not per-caller. */
export function pctColor(pct: number): string {
  if (pct >= 90) return "text-error";
  if (pct >= 70) return "text-warning";
  return "text-success";
}

/** Fill colour for a utilisation bar — same thresholds as `pctColor`. */
export function barColor(pct: number): string {
  if (pct >= 90) return "bg-error";
  if (pct >= 70) return "bg-warning";
  return "bg-success";
}

/**
 * "Resets in" for a bucket, from whichever of the three shapes the server sent.
 * Returns null when the bucket carries no reset information at all.
 */
export function formatResetTime(bucket?: LimitBucket): string | null {
  if (!bucket) return null;
  let totalMins: number | null = null;
  if (bucket.resetsInMinutes != null) {
    totalMins = bucket.resetsInMinutes;
  } else if (bucket.resetsInHours != null) {
    totalMins = Math.round(bucket.resetsInHours * 60);
  } else if (bucket.resetsAt) {
    const diff = new Date(bucket.resetsAt).getTime() - Date.now();
    totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  }
  if (totalMins == null) return null;
  if (totalMins <= 0) return "now";
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  if (d > 0) return m > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Time until a token expires. Takes milliseconds. */
/**
 * The exact moment a bucket resets, for the tooltip behind the relative "↻ 2h 10m".
 *
 * The relative figure is the right thing on the card — it answers "can I keep working" at a
 * glance — but it cannot answer "will this be back before my meeting", and it goes stale as
 * soon as it is rendered. The absolute time answers both, so it belongs one hover away rather
 * than competing for the same few pixels.
 *
 * Rendered in the viewer's own locale and zone: the server sends UTC, and a reset time shown
 * in UTC is a small puzzle to solve at exactly the moment someone is in a hurry.
 */
export function formatResetAt(resetsAt?: string | null): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * When a bucket resets, as an ISO timestamp, whichever of the three shapes the server sent.
 * A countdown is turned into a moment once, here, so it keeps counting down after it arrived.
 */
export function bucketResetsAt(bucket?: LimitBucket | null, now = Date.now()): string | null {
  if (!bucket) return null;
  if (bucket.resetsAt && Number.isFinite(new Date(bucket.resetsAt).getTime())) return bucket.resetsAt;
  if (bucket.resetsInMinutes != null) return new Date(now + bucket.resetsInMinutes * 60_000).toISOString();
  if (bucket.resetsInHours != null) return new Date(now + bucket.resetsInHours * 3_600_000).toISOString();
  return null;
}

/**
 * The countdown to a reset in two units at most — "in 3h 12m", "in 2d 8h", "in 40m" — the way
 * the quick views (the ··· menu, the usage rings' tooltip) say it. "now" once it has passed.
 */
export function formatResetCountdown(resetsAt: string | null | undefined, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt).getTime();
  if (!Number.isFinite(at)) return null;
  const mins = Math.ceil((at - now) / 60_000);
  if (mins <= 0) return "now";
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `in ${d}d${h > 0 ? ` ${h}h` : ""}`;
  if (h > 0) return `in ${h}h${m > 0 ? ` ${m}m` : ""}`;
  return `in ${m}m`;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/**
 * The clock time of a reset in the viewer's zone, as short as it can be without being
 * ambiguous: "03:52" within 12 hours, "today 18:00" later the same day, "Thu 09:00" within the
 * week, "Nov 18 09:00" beyond it.
 */
export function formatResetClock(resetsAt: string | null | undefined, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  if (!Number.isFinite(at.getTime())) return null;
  const time = at.toLocaleTimeString("en-US", CLOCK);
  const diff = at.getTime() - now;
  if (diff <= 12 * 3_600_000) return time;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return `today ${time}`;
  if (diff < 6.5 * 86_400_000) return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

/** Both, for Switch account's cards: "Resets in 3h 12m · 03:52". */
export function formatResetLine(resetsAt: string | null | undefined, now = Date.now()): string | null {
  const countdown = formatResetCountdown(resetsAt, now);
  if (!countdown) return null;
  if (countdown === "now") return "Resets now";
  return `Resets ${countdown} · ${formatResetClock(resetsAt, now)}`;
}

export function formatExpiry(expiresAtMs: number): string {
  const diff = expiresAtMs - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.ceil(diff / 60_000);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

/**
 * Human-readable token status.
 *
 * An expired token with a refresh token is only a warning, not an error: the server renews
 * it on the next call. Without one it is genuinely dead, which is why the two cases differ.
 *
 * Unless the server has already refused to renew it. PPM kept a rejected account holding its
 * refresh token — deliberately, so a re-import can recover it — and this function read that
 * as "will auto-renew" for six days while every turn on the account failed. A rejection
 * outranks both other cases.
 */
export function tokenStatus(info?: AccountInfo): { label: string; tip: string; color: string } {
  if (!info) return { label: "unknown", tip: "No account info available", color: "text-text-subtle" };
  if (!info.expiresAt) return { label: "key", tip: "API key (no expiry)", color: "text-text-subtle" };
  if (info.reauthRequired) {
    return { label: "sign in again", tip: "Anthropic rejected this account's refresh token. Sign in again to restore it.", color: "text-error" };
  }
  const expired = info.expiresAt * 1000 < Date.now(); // expiresAt is seconds
  if (expired && info.hasRefreshToken) return { label: "expired", tip: "Token expired but has refresh token — will auto-renew", color: "text-warning" };
  if (expired) return { label: "expired", tip: "Token expired, no refresh token", color: "text-error" };
  if (info.hasRefreshToken) return { label: "long-lived", tip: "OAuth token with refresh — long-lived", color: "text-success" };
  return { label: "temp", tip: "Temporary token without refresh — will expire", color: "text-warning" };
}

/** Relative age of a timestamp, for "last updated" labels. */
export function formatLastUpdated(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hrs < 24) return remainMins > 0 ? `${hrs}h ${remainMins}m ago` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
