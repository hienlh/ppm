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
 */
export function tokenStatus(info?: AccountInfo): { label: string; tip: string; color: string } {
  if (!info) return { label: "unknown", tip: "No account info available", color: "text-text-subtle" };
  if (!info.expiresAt) return { label: "key", tip: "API key (no expiry)", color: "text-text-subtle" };
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
