/**
 * Whether a person has touched any PPM browser tab recently.
 *
 * This is a signal for "do not propose a run right now / pause a running one",
 * never a permission to spend: the spend gate only ever opens on an approved
 * run or a turn a person typed (`turnOrigin === "ws"`), because presence can be
 * produced by code (an extension's own webview posting the activity message)
 * while the spend gate must not be.
 *
 * Memory only. A server restart means "not active" until the next real input —
 * accepted, because a proposal still needs rate limiting and an explicit click
 * regardless of what presence says.
 */

export interface PresenceSnapshot {
  lastInputAt: string | null;
  idleMs: number | null;
  active: boolean;
  activeWindowMs: number;
}

const DEFAULT_ACTIVE_WINDOW_MS = 600_000;

/**
 * Read once, at module load: an e2e fixture sets `PPM_PRESENCE_ACTIVE_MS` before the server
 * starts so "idle" is reachable in seconds instead of ten real minutes. A value set after the
 * server is already running has no effect, by design — the window is not meant to change
 * mid-session.
 */
function activeWindowFromEnv(): number {
  const raw = process.env.PPM_PRESENCE_ACTIVE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACTIVE_WINDOW_MS;
}

const ACTIVE_WINDOW_MS = activeWindowFromEnv();

export class PresenceTracker {
  private lastInputAtMs: number | null = null;

  /** Test seam: a tracker with its own window, independent of the process env. */
  constructor(private readonly activeWindowMs: number = ACTIVE_WINDOW_MS) {}

  /**
   * A real input event just happened on some PPM tab's document, or an extension webview sent
   * its explicit `__ppm.userActivity` message from one of its own. Never call this for
   * ordinary protocol traffic (an RPC reply, a file-icon request, an iframe reload) — those
   * reach the parent's message listener too, but are not a person doing anything.
   */
  noteUserInput(now: number = Date.now()): void {
    this.lastInputAtMs = now;
  }

  /** Snapshot as of `now` (defaults to the real clock; tests pass their own). */
  presence(now: number = Date.now()): PresenceSnapshot {
    if (this.lastInputAtMs == null) {
      return { lastInputAt: null, idleMs: null, active: false, activeWindowMs: this.activeWindowMs };
    }
    const idleMs = now - this.lastInputAtMs;
    return {
      lastInputAt: new Date(this.lastInputAtMs).toISOString(),
      idleMs,
      active: idleMs <= this.activeWindowMs,
      activeWindowMs: this.activeWindowMs,
    };
  }
}

/** The one tracker the global WS handler and the `presence:get` RPC both read and write. */
export const presenceTracker = new PresenceTracker();
