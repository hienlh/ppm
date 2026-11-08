import { createCallLimiter, type CallLimiter } from "../tab-tools-mcp/session-history-rate-limit.ts";

/**
 * How often one chat session may call the session tools: 30 calls a sliding minute and 3 in flight,
 * shared across the three. A call that waits for a reply holds its in-flight slot for as long as it
 * waits; `session_status` counts against the minute but never needs a slot, so an AI with every
 * slot held by waits can still check on the sessions it is waiting for.
 */

export const SESSION_COLLAB_CALLS_PER_MINUTE = 30;
export const SESSION_COLLAB_IN_FLIGHT = 3;

export function createCollabLimiter(opts: { now?: () => number } = {}): CallLimiter {
  return createCallLimiter({
    perMinute: SESSION_COLLAB_CALLS_PER_MINUTE,
    inFlight: SESSION_COLLAB_IN_FLIGHT,
    label: "session tool",
    ...(opts.now ? { now: opts.now } : {}),
  });
}
