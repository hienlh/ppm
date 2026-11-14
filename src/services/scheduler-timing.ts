/** When schedules fire, and how long the scheduler's timer may sleep before looking again. */
import { Cron } from "croner";
import type { Schedule } from "../types/scheduler.ts";

/** Longest the timer sleeps, so a clock jump or a machine waking from sleep is caught within a minute. */
export const MAX_SLEEP_MS = 60_000;
/** A timer that fires a hair early finds nothing due and re-arms after this, never in a tight loop. */
const MIN_SLEEP_MS = 20;

/**
 * The first match of `cronExpr` after `from` (now by default), read in `timezone` — an IANA name,
 * or the machine's own zone when absent. Throws when the expression does not parse.
 */
export function nextFireAt(cronExpr: string, timezone?: string | null, from?: Date): string | null {
  return new Cron(cronExpr, timezone ? { timezone } : {}).nextRun(from)?.toISOString() ?? null;
}

/**
 * The fire after the one that just came due. A one-shot session schedule has none: it waits,
 * with no next fire, until its single fire is delivered and it is deleted.
 */
export function followingFireAt(schedule: Pick<Schedule, "kind" | "recurring" | "cron_expr" | "timezone">, from?: Date): string | null {
  if (schedule.kind === "session" && !schedule.recurring) return null;
  return nextFireAt(schedule.cron_expr, schedule.timezone, from);
}

/** How long to sleep before the earliest due schedule `at` (ISO), within the bounds above. */
export function wakeDelay(at: string | null, now = Date.now()): number {
  if (!at) return MAX_SLEEP_MS;
  return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, Date.parse(at) - now));
}
