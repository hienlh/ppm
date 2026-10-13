/** When schedules fire, and how long the scheduler's timer may sleep before looking again. */
import { Cron } from "croner";

/** Longest the timer sleeps, so a clock jump or a machine waking from sleep is caught within a minute. */
export const MAX_SLEEP_MS = 60_000;
/** A timer that fires a hair early finds nothing due and re-arms after this, never in a tight loop. */
const MIN_SLEEP_MS = 20;

export function nextFireAt(cronExpr: string): string | null {
  return new Cron(cronExpr).nextRun()?.toISOString() ?? null;
}

/** How long to sleep before the earliest due schedule `at` (ISO), within the bounds above. */
export function wakeDelay(at: string | null, now = Date.now()): number {
  if (!at) return MAX_SLEEP_MS;
  return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, Date.parse(at) - now));
}
