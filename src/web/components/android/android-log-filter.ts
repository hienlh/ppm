/**
 * What the log panel shows, as pure functions.
 *
 * Separate from the component because a zustand-touching or DOM-touching module cannot be loaded
 * under `bun:test` (the stores read `localStorage` at import time), and these three decisions —
 * which level counts, what the search matches, how the ring is bounded — are exactly the ones
 * worth pinning.
 */
import type { AndroidLogEntry, AndroidLogLevel } from "../../../shared/android-protocol";

/** Ascending severity. The panel's picker is a *minimum*, so the order is the whole mechanism. */
export const LOG_LEVELS: AndroidLogLevel[] = ["verbose", "debug", "info", "warn", "error", "fatal"];

const RANK = new Map(LOG_LEVELS.map((l, i) => [l, i]));

export function meetsLevel(level: AndroidLogLevel, minimum: AndroidLogLevel): boolean {
  return (RANK.get(level) ?? 0) >= (RANK.get(minimum) ?? 0);
}

export interface LogFilter {
  minimum: AndroidLogLevel;
  /** Matched case-insensitively against the tag and the message, never against the pid. */
  text: string;
  /** Only entries from this pid. 0 means every process. */
  pid: number;
}

export const EMPTY_FILTER: LogFilter = { minimum: "verbose", text: "", pid: 0 };

export function matchesFilter(entry: AndroidLogEntry, filter: LogFilter): boolean {
  if (!meetsLevel(entry.level, filter.minimum)) return false;
  if (filter.pid !== 0 && entry.pid !== filter.pid) return false;
  const needle = filter.text.trim().toLowerCase();
  if (needle.length === 0) return true;
  return entry.tag.toLowerCase().includes(needle) || entry.message.toLowerCase().includes(needle);
}

/**
 * Append a batch and keep the newest `max`.
 *
 * Returns the same array reference when nothing arrived, so a React state setter given this can
 * bail out instead of re-rendering — a device logging nothing must not cost a render a tick.
 */
export function appendBounded(
  existing: AndroidLogEntry[],
  incoming: AndroidLogEntry[],
  max: number,
): AndroidLogEntry[] {
  if (incoming.length === 0) return existing;
  // A reconnection replays the server's whole ring, so the same ids arrive twice. Dropping by id
  // is cheaper than it looks: the overlap is always at the head, and ids are monotonic per
  // device, so a single comparison against the last id we hold answers it for the common case.
  const lastId = existing.length > 0 ? existing[existing.length - 1]!.id : 0;
  const fresh = incoming[0]!.id > lastId ? incoming : incoming.filter((e) => e.id > lastId);
  if (fresh.length === 0) return existing;
  const merged = existing.concat(fresh);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** `13:09:42.640`, local time — the date is in the header, and a log row has no room for it. */
export function formatLogTime(timestamp: number): string {
  const d = new Date(timestamp);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One line per entry, in logcat's own `threadtime` shape, for copy and for a saved file. */
export function formatLogText(entries: AndroidLogEntry[]): string {
  const letter: Record<AndroidLogLevel, string> = {
    verbose: "V", debug: "D", info: "I", warn: "W", error: "E", fatal: "F",
  };
  return entries
    .map((e) => `${formatLogTime(e.timestamp)} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${letter[e.level]} ${e.tag}: ${e.message}`)
    .join("\n");
}
