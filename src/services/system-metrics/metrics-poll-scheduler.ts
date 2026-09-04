/**
 * Turns live subscriber demand into exactly one poll timer, plus the delayed
 * child teardown when full-tier demand disappears. Timers follow demand:
 * ≥1 full subscriber → full cadence; else ≥1 light → light cadence; else none.
 */
import type { MetricsTier } from "../../types/system-metrics.ts";

export interface PollSchedulerOptions {
  intervals: { full: number; light: number };
  /** Grace before `onIdle` fires after the last full subscriber leaves, so a
   *  window reopen does not pay the PowerShell bootstrap again. */
  idleTeardownMs: number;
  onTick: () => void;
  /** Full-tier demand has been absent for the whole grace period. */
  onIdle: () => void;
  /** Full-tier collection is about to start for the first time. */
  onFullStart: () => void;
}

export class PollScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tier: MetricsTier | null = null;

  constructor(private readonly opts: PollSchedulerOptions) {}

  activeTier(): MetricsTier | null {
    return this.tier;
  }

  /** Returns true when the active tier changed (so delta baselines may need a reset). */
  reconcile(fullCount: number, lightCount: number): boolean {
    const desired: MetricsTier | null = fullCount > 0 ? "full" : lightCount > 0 ? "light" : null;
    if (desired === "full") this.clearIdle();
    else if (this.tier === "full") this.armIdle();
    if (desired === this.tier) return false;

    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tier = desired;
    if (desired === "full") this.opts.onFullStart();
    if (desired) {
      this.timer = setInterval(this.opts.onTick, this.opts.intervals[desired]);
      this.opts.onTick();
    }
    return true;
  }

  /** Re-arm the idle teardown after an out-of-band full collection (a kill). */
  armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.tier !== "full") this.opts.onIdle();
    }, this.opts.idleTeardownMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tier = null;
    this.clearIdle();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const installedTeardowns = new WeakSet<() => void>();

/** A hard exit must not leave a PowerShell child holding the server's
 *  inheritable listening socket (the zombie-port state). The server's own
 *  SIGTERM/SIGINT handler calls `process.exit`, which fires `exit` — so this
 *  hook only tears down and never exits itself. Installed once per teardown fn. */
export function installProcessExitHooks(teardown: () => void): void {
  if (installedTeardowns.has(teardown)) return;
  installedTeardowns.add(teardown);
  process.on("exit", teardown);
  process.on("SIGTERM", teardown);
  process.on("SIGINT", teardown);
}
