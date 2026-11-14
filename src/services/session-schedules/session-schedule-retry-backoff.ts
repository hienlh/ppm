/**
 * Consecutive failures of one chat's session schedules, and the wait before that chat is tried
 * again. A failure here is one that may pass — the session would not resume, the message could not
 * be pushed, a turn failed before it did anything — so the fire stays pending and is tried again
 * after 1, 5, then 15 minutes; one failure more than there are waits and the chat's schedules are
 * paused.
 *
 * Counted per chat, not per schedule: what fails is nearly always the chat (its session, its
 * account), so a second schedule sent into it at once would only fail too, and each would bring
 * its own retries and its own notice.
 *
 * Kept in memory: a restart forgets the count, and the pending fires are handed over again then.
 */

/** Waits after the first, second and third failure in a row; the fourth pauses the chat's schedules. */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];

export type BackoffVerdict =
  | { verdict: "retry"; failures: number; delayMs: number }
  | { verdict: "give_up"; failures: number };

interface BackoffEntry {
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  /** When the timer hands the chat back (epoch ms), while it runs. */
  until?: number;
}

export class ScheduleRetryBackoff {
  private readonly byChat = new Map<string, BackoffEntry>();

  constructor(private readonly delays: readonly number[], private readonly now: () => number = Date.now) {}

  /** Waiting out a backoff: nothing is sent into the chat before its timer hands it back. */
  isWaiting(sessionId: string): boolean {
    return this.byChat.get(sessionId)?.timer !== undefined;
  }

  /** When the chat is tried again (epoch ms), or null when it is not waiting. */
  retryAt(sessionId: string): number | null {
    const entry = this.byChat.get(sessionId);
    return entry?.timer !== undefined && entry.until !== undefined ? entry.until : null;
  }

  /**
   * Count a failure. Within the allowance, `again` runs once the wait is over; past it the count
   * is dropped and the caller pauses the chat's schedules.
   */
  fail(sessionId: string, again: () => void): BackoffVerdict {
    const entry = this.byChat.get(sessionId) ?? { failures: 0 };
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.until = undefined;
    entry.failures += 1;
    const delayMs = this.delays[entry.failures - 1];
    if (delayMs === undefined) {
      this.byChat.delete(sessionId);
      return { verdict: "give_up", failures: entry.failures };
    }
    entry.until = this.now() + delayMs;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.until = undefined;
      again();
    }, delayMs);
    (entry.timer as { unref?: () => void }).unref?.();
    this.byChat.set(sessionId, entry);
    return { verdict: "retry", failures: entry.failures, delayMs };
  }

  /** The chat took a turn: its next failure counts from one again. */
  succeeded(sessionId: string): void {
    const entry = this.byChat.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.byChat.delete(sessionId);
  }

  /** The provider renamed the chat: its count and its wait go with it. */
  rename(oldId: string, newId: string): void {
    const entry = this.byChat.get(oldId);
    if (!entry) return;
    this.byChat.delete(oldId);
    this.byChat.set(newId, entry);
  }

  clear(): void {
    for (const entry of this.byChat.values()) if (entry.timer) clearTimeout(entry.timer);
    this.byChat.clear();
  }
}

/** "1 minute", "5 minutes": how a wait reads in a notice or a log line. */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
