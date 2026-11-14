/**
 * Consecutive failures of one session schedule, and the wait before it is tried again. A failure
 * here is one that may pass — the session would not resume, the message could not be pushed, a
 * one-shot's turn failed before it ran — so the fire stays pending and is tried again after
 * 1, 5, then 15 minutes; one failure more than there are waits and the schedule is paused.
 *
 * Kept in memory: a restart forgets the count, and the pending fire is handed over again then.
 */

/** Waits after the first, second and third failure in a row; the fourth pauses the schedule. */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];

export type BackoffVerdict =
  | { verdict: "retry"; failures: number; delayMs: number }
  | { verdict: "give_up"; failures: number };

export class ScheduleRetryBackoff {
  private readonly byId = new Map<number, { failures: number; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly delays: readonly number[]) {}

  /** Waiting out a backoff: nothing sends it before its timer hands it back. */
  isWaiting(scheduleId: number): boolean {
    return this.byId.get(scheduleId)?.timer !== undefined;
  }

  /**
   * Count a failure. Within the allowance, `again` runs once the wait is over; past it the count
   * is dropped and the caller pauses the schedule.
   */
  fail(scheduleId: number, again: () => void): BackoffVerdict {
    const entry = this.byId.get(scheduleId) ?? { failures: 0 };
    if (entry.timer) clearTimeout(entry.timer);
    entry.failures += 1;
    const delayMs = this.delays[entry.failures - 1];
    if (delayMs === undefined) {
      this.byId.delete(scheduleId);
      return { verdict: "give_up", failures: entry.failures };
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      again();
    }, delayMs);
    (entry.timer as { unref?: () => void }).unref?.();
    this.byId.set(scheduleId, entry);
    return { verdict: "retry", failures: entry.failures, delayMs };
  }

  /** It went through: the next failure counts from one again. */
  succeeded(scheduleId: number): void {
    const entry = this.byId.get(scheduleId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.byId.delete(scheduleId);
  }

  clear(): void {
    for (const entry of this.byId.values()) if (entry.timer) clearTimeout(entry.timer);
    this.byId.clear();
  }
}

/** "1 minute", "5 minutes": how a wait reads in a notice or a log line. */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
