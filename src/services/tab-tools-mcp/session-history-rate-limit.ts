/**
 * How often one chat session may call the session-history tools: a sliding minute of calls and a
 * cap on calls in flight, shared across the three tools. Reading turns walks transcripts, and an
 * agent stuck in a loop must not keep the server doing that.
 */

export const SESSION_HISTORY_CALLS_PER_MINUTE = 20;
export const SESSION_HISTORY_IN_FLIGHT = 2;
const WINDOW_MS = 60_000;

export type LimitOutcome = { ok: true; release: () => void } | { ok: false; message: string };

export interface CallLimiter {
  /** A slot for one call of `key` (the caller's canonical session id), or why there is none. */
  acquire(key: string): LimitOutcome;
  /** How many callers the limiter still remembers; for tests and diagnostics. */
  trackedKeys(): number;
}

export function createCallLimiter(opts: { perMinute?: number; inFlight?: number; now?: () => number } = {}): CallLimiter {
  const perMinute = opts.perMinute ?? SESSION_HISTORY_CALLS_PER_MINUTE;
  const maxInFlight = opts.inFlight ?? SESSION_HISTORY_IN_FLIGHT;
  const now = opts.now ?? Date.now;
  const recent = new Map<string, number[]>();
  const running = new Map<string, number>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  /**
   * Forgets every caller whose last call left the window and that has none running, at most once a
   * window. A release can only forget its own caller while that caller's calls are still in the
   * window, so without this every chat that ever called would stay in the map for good.
   */
  const sweep = (t: number) => {
    if (t - lastSweep < WINDOW_MS) return;
    lastSweep = t;
    for (const [key, calls] of recent) {
      const newest = calls[calls.length - 1];
      if (!running.has(key) && (newest === undefined || t - newest >= WINDOW_MS)) recent.delete(key);
    }
  };

  return {
    trackedKeys: () => recent.size,
    acquire(key) {
      const t = now();
      sweep(t);
      const calls = (recent.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
      if ((running.get(key) ?? 0) >= maxInFlight) {
        return { ok: false, message: `At most ${maxInFlight} session-history calls may run at once; wait for one to finish.` };
      }
      if (calls.length >= perMinute) {
        recent.set(key, calls);
        return { ok: false, message: `At most ${perMinute} session-history calls a minute; wait a little before the next.` };
      }
      calls.push(t);
      recent.set(key, calls);
      running.set(key, (running.get(key) ?? 0) + 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          const left = (running.get(key) ?? 1) - 1;
          if (left > 0) running.set(key, left);
          else running.delete(key);
          // Forget a session that has gone quiet, so the map does not grow with every chat.
          const live = (recent.get(key) ?? []).filter((at) => now() - at < WINDOW_MS);
          if (!live.length && left <= 0) recent.delete(key);
          else recent.set(key, live);
        },
      };
    },
  };
}
