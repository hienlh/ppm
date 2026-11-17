/**
 * What the Schedules window and the rail's button say about a schedule without asking the server
 * again: whether it needs the user (the red dot), and whether it fires in the next 24 hours (the
 * count). Pure, so the server's list and the browser's minute-by-minute recount agree.
 *
 * A problem has a key naming that one occurrence (the run that failed, the fire that waits). The
 * user's Dismiss stores the key; the dot comes back only for a different problem. A later run that
 * succeeds clears it by itself, since the newest run is then no problem at all.
 */
import type { ScheduleKind, ScheduleLastRun, ScheduleMode } from "../types/scheduler.ts";

/** A due session schedule still waiting for its chat after this long is worth a look. */
export const WAITING_TOO_LONG_MS = 10 * 60_000;
/** The window the rail's count covers. */
export const UPCOMING_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A stored timestamp as epoch ms. Run rows default to SQLite's own `YYYY-MM-DD HH:MM:SS`, which is
 * UTC but carries no zone, so `Date.parse` would read it on the device's clock; ISO strings pass.
 */
export function parseStamp(ts: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(ts) ? `${ts.replace(" ", "T")}Z` : ts);
}

export type AttentionKind = "failed" | "stuck" | "paused" | "waiting";

export interface ScheduleProblem {
  kind: AttentionKind;
  /** Names this occurrence: `failed:<run id>`, `stuck:<run id>`, `paused:<reason>`, `waiting:<since>`. */
  key: string;
  /** One line for the row: "Last run failed", "Stuck: running 41 min". */
  text: string;
  /** The error or the reason, when there is one. */
  detail: string | null;
}

export interface AttentionInput {
  kind: ScheduleKind;
  mode: ScheduleMode;
  enabled: number;
  timeout_ms: number;
  paused_reason: string | null;
  pending_since: string | null;
  attention_dismissed: string | null;
  last_run: ScheduleLastRun | null;
}

const minutes = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
};

/** The schedule's current problem, dismissed or not; null when there is none (or it is off). */
export function scheduleProblem(s: AttentionInput, now: number = Date.now()): ScheduleProblem | null {
  if (!s.enabled) return null;
  if (s.paused_reason) {
    return { kind: "paused", key: `paused:${s.paused_reason}`, text: "Paused", detail: s.paused_reason };
  }
  if (s.pending_since) {
    const waited = now - parseStamp(s.pending_since);
    if (waited >= WAITING_TOO_LONG_MS) {
      return { kind: "waiting", key: `waiting:${s.pending_since}`, text: `Waiting for its chat ${minutes(waited)}`, detail: null };
    }
  }
  const run = s.last_run;
  if (!run) return null;
  // An always-on script's run row is its process, which is meant to run for good.
  if (run.status === "running" && s.mode === "tick") {
    const ran = now - parseStamp(run.started_at);
    if (ran > s.timeout_ms) {
      return { kind: "stuck", key: `stuck:${run.id}`, text: `Stuck: running ${minutes(ran)}`, detail: `Its time limit is ${minutes(s.timeout_ms)}.` };
    }
  }
  if (run.status === "error") return { kind: "failed", key: `failed:${run.id}`, text: "Last run failed", detail: run.error };
  return null;
}

/** The problem the red dot is for: one the user has not dismissed. */
export function scheduleAttention(s: AttentionInput, now: number = Date.now()): ScheduleProblem | null {
  const problem = scheduleProblem(s, now);
  return problem && problem.key !== s.attention_dismissed ? problem : null;
}

export interface UpcomingInput {
  enabled: number;
  mode: ScheduleMode;
  paused_reason: string | null;
  pending_since: string | null;
  next_fire_at: string | null;
}

/**
 * Whether the schedule goes out within the next 24 hours: its next fire falls inside the window,
 * or a fire already came due and waits. A schedule firing every five minutes counts once; an
 * always-on script is never "about to run".
 */
export function firesWithin(s: UpcomingInput, now: number = Date.now(), windowMs = UPCOMING_WINDOW_MS): boolean {
  if (!s.enabled || s.paused_reason || s.mode !== "tick") return false;
  if (s.pending_since) return true;
  if (!s.next_fire_at) return false;
  const at = parseStamp(s.next_fire_at);
  return Number.isFinite(at) && at <= now + windowMs;
}

/** The rail button's numbers: schedules about to run, and problems not dismissed. */
export function railSummary(list: ReadonlyArray<AttentionInput & UpcomingInput>, now: number = Date.now()): { upcoming: number; attention: number } {
  let upcoming = 0;
  let attention = 0;
  for (const s of list) {
    if (firesWithin(s, now)) upcoming += 1;
    if (scheduleAttention(s, now)) attention += 1;
  }
  return { upcoming, attention };
}
