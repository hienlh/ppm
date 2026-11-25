/**
 * Whether the link to the viewer is what holds the stream back, and how many pictures a second
 * it carries when it is.
 *
 * The pacer never has more than two pictures undrawn by the viewer, so a slow link shows up as
 * the pacer waiting on the viewer's acks; the rate of those acks is then what the link carries.
 * While the pacer never waits on the viewer, the link keeps up and there is nothing to report.
 *
 * Measured: estimating the link's bytes a second from each picture's send→ack time and pacing to
 * that lowered scrolling over 5 Mbit/s from 8.3 to 6.1 pictures a second without making typing
 * any faster. The two-picture window already follows the link; this only says when it is the
 * limit.
 */

/** How far back acks and waits are looked at. */
export const LINK_WINDOW_MS = 2000;

export class LinkMonitor {
  private acks: number[] = [];
  private limited: number[] = [];

  /** The viewer acknowledged a picture. */
  onViewerAck(at = Date.now()): void {
    this.acks.push(at);
    this.prune(at);
  }

  /** The pacer had to wait for the viewer before letting Chrome send another picture. */
  onViewerLimited(at = Date.now()): void {
    if (this.limited[this.limited.length - 1] === at) return;
    this.limited.push(at);
    this.prune(at);
  }

  /** Pictures a second the link carried lately, if it was the limit; null if it kept up. */
  linkFps(now = Date.now()): number | null {
    this.prune(now);
    if (this.limited.length === 0 || this.acks.length < 3) return null;
    const span = this.acks[this.acks.length - 1]! - this.acks[0]!;
    return span > 0 ? ((this.acks.length - 1) * 1000) / span : null;
  }

  reset(): void {
    this.acks = [];
    this.limited = [];
  }

  private prune(now: number): void {
    const from = now - LINK_WINDOW_MS;
    while (this.acks.length && this.acks[0]! < from) this.acks.shift();
    while (this.limited.length && this.limited[0]! < from) this.limited.shift();
  }
}
