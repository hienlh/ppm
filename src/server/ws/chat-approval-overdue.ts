/**
 * One timer per card on a chat's screen: a card still there after `delayMs` is overdue, and
 * `fire` is told once. A card that leaves (answered, given up, the turn ended) cancels its timer.
 * Kept apart from the socket layer so the timing is testable with a fake clock.
 */
export interface OverdueTimerDeps {
  /** Read at each arm, so a test can shorten it for the cards shown after. */
  delayMs: () => number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  fire(sessionId: string, requestId: string, shownAt: number): void;
  now(): number;
}

export function createApprovalOverdueTimers(deps: OverdueTimerDeps) {
  const timers = new Map<string, unknown>();
  return {
    /** The card `requestId` is now on `sessionId`'s screen. Arming it again keeps the first timer. */
    arm(sessionId: string, requestId: string): void {
      if (timers.has(requestId)) return;
      const shownAt = deps.now();
      timers.set(requestId, deps.setTimer(() => {
        timers.delete(requestId);
        deps.fire(sessionId, requestId, shownAt);
      }, deps.delayMs()));
    },
    /** The card left the screen. */
    cancel(requestId: string): void {
      const handle = timers.get(requestId);
      if (handle === undefined) return;
      timers.delete(requestId);
      deps.clearTimer(handle);
    },
    /** For tests and shutdown. */
    size: (): number => timers.size,
  };
}
