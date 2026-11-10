/**
 * The time PPM Assistant's own schedules run on: send budgets, quiet hours, and later the wake
 * queue, the digest and the failed-card grace. One injectable clock, so tests and the e2e can
 * move time instead of waiting for it.
 */

export type Cancel = () => void;

export interface AssistantClock {
  now(): number;
  setTimer(fn: () => void, ms: number): Cancel;
}

export const systemClock: AssistantClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};

let current: AssistantClock = systemClock;

/** The clock every Assistant schedule reads. */
export const assistantClock: AssistantClock = {
  now: () => current.now(),
  setTimer: (fn, ms) => current.setTimer(fn, ms),
};

/** Replaces the clock (tests, the e2e); null puts the system clock back. */
export function setAssistantClock(clock: AssistantClock | null): void {
  current = clock ?? systemClock;
}
