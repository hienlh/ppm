/**
 * Test seams for the hub's two time-driven behaviors: "what time is it" and
 * "call me back in N ms". Mutable singletons (same shape as
 * `designWriteClock` in `design-write-rate-limit.ts`) rather than constructor
 * parameters threaded through every function, so a unit test can swap either
 * one out for the duration of a case and put it back.
 *
 * A test that wants deterministic ticks replaces `setInterval` with a no-op
 * that never actually schedules anything, then drives the hub by calling its
 * internal tick function directly while moving `clock.now` forward by hand —
 * real wall-clock delays never enter the picture.
 */

export interface AgentTranscriptClock {
  now(): number;
}

export const agentTranscriptClock: AgentTranscriptClock = {
  now: () => Date.now(),
};

export interface AgentTranscriptTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const agentTranscriptTimers: AgentTranscriptTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Restore both seams to their real implementations; call from `afterEach`. */
export function resetAgentTranscriptClockForTest(): void {
  agentTranscriptClock.now = () => Date.now();
  agentTranscriptTimers.setInterval = (fn, ms) => setInterval(fn, ms);
  agentTranscriptTimers.clearInterval = (handle) => clearInterval(handle as ReturnType<typeof setInterval>);
}
