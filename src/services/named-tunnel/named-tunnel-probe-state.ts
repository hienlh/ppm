/**
 * Pure decision function for the named-tunnel probe's "restart once, then warn
 * and stop" state machine. Kept separate from `supervisor.ts` (which owns the
 * actual kill/respawn/status-write side effects) so the transition logic is
 * unit-testable without spawning a real cloudflared process or timers.
 *
 * The bug this exists to prevent: resetting `restartAttempted` anywhere other
 * than a confirmed-healthy observation lets a dark hostname (e.g. the CNAME
 * deleted in the dashboard) restart the connector every threshold window
 * forever, because the RESTART itself always "succeeds" (cloudflared happily
 * reconnects to Cloudflare's edge) even though the DNS route it needs is gone —
 * a spawn success is not proof the hostname is reachable, only the probe's own
 * fetch against the public URL is.
 */

export interface NamedProbeState {
  /** Consecutive unhealthy probe cycles observed since the last reset. */
  failCount: number;
  /** Whether the one allowed restart-and-hope has already been used since the
   *  last confirmed-healthy observation. */
  restartAttempted: boolean;
}

export type NamedProbeAction =
  | { type: "healthy" }
  | { type: "watch" }
  | { type: "restart-once" }
  | { type: "warn-and-stop" };

export interface NamedProbeDecision {
  action: NamedProbeAction;
  nextState: NamedProbeState;
}

/**
 * Decide the next action for one probe tick.
 *
 * - `healthy` → both counters reset to a clean slate (the only place
 *   `restartAttempted` ever goes back to `false`).
 * - unhealthy below `threshold` → `watch` (just count, no action).
 * - unhealthy at/above `threshold`, first time → `restart-once` (kill +
 *   respawn the connector; arms `restartAttempted` so this never repeats
 *   until a healthy observation clears it).
 * - unhealthy at/above `threshold`, restart already attempted → `warn-and-stop`
 *   (surface the warning; never kill again — the pinned URL stays put).
 */
export function decideNamedProbeAction(
  healthy: boolean,
  state: NamedProbeState,
  threshold: number,
): NamedProbeDecision {
  if (healthy) {
    return { action: { type: "healthy" }, nextState: { failCount: 0, restartAttempted: false } };
  }

  const failCount = state.failCount + 1;
  if (failCount < threshold) {
    return { action: { type: "watch" }, nextState: { failCount, restartAttempted: state.restartAttempted } };
  }

  if (!state.restartAttempted) {
    return { action: { type: "restart-once" }, nextState: { failCount: 0, restartAttempted: true } };
  }

  return { action: { type: "warn-and-stop" }, nextState: { failCount: 0, restartAttempted: true } };
}
