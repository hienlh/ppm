/**
 * One holder at a time for the process collector. The PowerShell session takes
 * a single request at a time, and a kill re-collects through the same collector
 * the poll tick uses — so a kill waits for an in-flight tick, while a tick that
 * arrives during a kill (or another tick) is simply skipped: metrics are lossy,
 * a dropped poll is harmless, but two overlapping collections would either fail
 * with "request already in flight" or double-consume the CPU delta baseline.
 */
export class CollectorLock {
  private inflight: Promise<unknown> | null = null;

  isHeld(): boolean {
    return this.inflight !== null;
  }

  /** Run now if free, otherwise skip and resolve to `null`. */
  async tryRun<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.inflight) return null;
    return this.hold(work());
  }

  /** Wait for the current holder (however it ends), then run. */
  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    while (this.inflight) await this.inflight.catch(() => {});
    return this.hold(work());
  }

  private async hold<T>(p: Promise<T>): Promise<T> {
    this.inflight = p;
    try {
      return await p;
    } finally {
      this.inflight = null;
    }
  }
}
