/**
 * Pure halves of Settings → Storage: checking the session trace limits before they are sent,
 * and the "used of cap" figure. Kept out of the pane so `bun:test` can import them without
 * pulling in React or the stores.
 */
import {
  SESSION_TRACE_MIN_RETENTION_DAYS,
  SESSION_TRACE_MIN_SIZE_MB,
  type SessionTraceLimitsInput,
} from "../../shared/storage-settings";
import { formatBytes } from "./format-bytes";

export type TraceLimitsCheck =
  | { ok: true; value: Required<SessionTraceLimitsInput> }
  | { ok: false; error: string };

/** A whole number written in the field, or null for anything else ("", "1.5", "1e3", "abc"). */
function parseWholeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Validates the two form fields against the same floors the route enforces, so an obvious
 * mistake is caught before a round trip. The server still has the last word.
 */
export function checkSessionTraceLimits(days: string, sizeMb: string): TraceLimitsCheck {
  const retention = parseWholeNumber(days);
  if (retention === null || retention < SESSION_TRACE_MIN_RETENTION_DAYS) {
    return { ok: false, error: `Keep for must be a whole number of at least ${SESSION_TRACE_MIN_RETENTION_DAYS} day.` };
  }
  const size = parseWholeNumber(sizeMb);
  if (size === null || size < SESSION_TRACE_MIN_SIZE_MB) {
    return { ok: false, error: `Max size must be a whole number of at least ${SESSION_TRACE_MIN_SIZE_MB} MB.` };
  }
  return { ok: true, value: { retention_days: retention, max_size_mb: size } };
}

export interface TraceUsage {
  /** e.g. "412 MB of 500 MB". */
  label: string;
  /** Share of the cap in use, clamped to 0–1 for the bar. */
  fraction: number;
  /** The file is past its cap (the daily cleanup has not caught up yet). */
  over: boolean;
}

export function traceUsage(sizeBytes: number, maxSizeMb: number): TraceUsage {
  const capBytes = maxSizeMb * 1024 * 1024;
  const raw = capBytes > 0 && Number.isFinite(sizeBytes) ? sizeBytes / capBytes : 0;
  return {
    label: `${formatBytes(sizeBytes)} of ${formatBytes(capBytes)}`,
    fraction: Math.min(1, Math.max(0, raw)),
    over: raw > 1,
  };
}
