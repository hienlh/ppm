/**
 * Pictures of the tab on screen, sent to the one viewer in control, at a pace the viewer sets.
 *
 * Chrome sends the next screencast frame only after an earlier one is acknowledged, so the
 * acknowledgement is the throttle. It is sent once two things hold: fewer than
 * `MAX_IN_FLIGHT` pictures are still unacknowledged by the viewer (its `frame.ack` after it has
 * drawn one), and one interval has passed since the previous ack. A slow link therefore slows the
 * stream down instead of queueing pictures in PPM — the socket's own buffered amount cannot be
 * the signal, because Bun's barely ever grows (CLAUDE.md, "Reacting to a backpressure spike").
 * Two in flight rather than one, or a relayed link would cap the rate at one picture per round
 * trip.
 *
 * Three things measured on a 5 Mbit/s, 93 ms link (plans/reports/research-261125-2048-web-browser-lag.md)
 * shape the rest:
 * - Chrome takes ~20–25 ms after an ack to capture and encode the next frame. Timing the ack from
 *   the last frame's arrival put that delay on top of every interval (12 fps came out as 9.5), so
 *   acks are timed from the previous ack: the capture delay falls inside the interval.
 * - Chrome keeps more than one frame in flight: after an ack it may send two in a row. Acking all
 *   of them at once let pictures arrive in pairs (30 a second at a ceiling of 12), so one ack
 *   goes out per interval, oldest first, until all are acked. None is dropped: Chrome's own
 *   count of frames in flight would drift and, once full, a change could no longer reach the
 *   viewer.
 * - While Chrome waits for an ack it drops the page's repaints and does not send them later: a
 *   keystroke painted during the wait showed only at the caret's next blink, ~530 ms on (15 of
 *   30 keystrokes). So once the person stops for `SETTLE_MS` and Chrome was held at any point
 *   since their input, the screencast is restarted, which makes Chrome send the page as it is.
 *   Acking Chrome at once instead fixed it too but made Chrome encode every repaint (CPU 30 %
 *   → 80 % of a core while scrolling).
 */
import type { CdpConnection } from "./cdp-connection.ts";
import { encodePictureFrame } from "../../shared/web-browser-binary-frames.ts";
import type { Viewport } from "./input-bridge.ts";

export const MAX_IN_FLIGHT = 2;
/** Quiet time after the person's last input before a held stream is refreshed. */
export const SETTLE_MS = 120;

export interface PacerSink {
  sendBinary(bytes: Uint8Array): void;
}

export class ScreencastPacer {
  private sessionId: string | null = null;
  private viewport: Viewport | null = null;
  private seq = 0;
  /** Pictures the viewer has not acknowledged yet. */
  private inFlight = 0;
  /** Frames Chrome sent that PPM has not acknowledged yet, and the screencast id they carry. */
  private chromeUnacked = 0;
  private chromeSession = 0;
  /** When Chrome was last acknowledged; the next ack is due one interval later. */
  private lastAckAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The person acted, and Chrome has been held since: a repaint may be missing. */
  private inputPending = false;
  private heldSinceInput = false;
  private readonly off: () => void;

  constructor(
    private readonly cdp: CdpConnection,
    private readonly sink: PacerSink,
    private readonly opts: () => { fpsCap: number; jpegQuality: number },
  ) {
    this.off = cdp.onEvent((e) => {
      if (e.method !== "Page.screencastFrame" || e.sessionId !== this.sessionId) return;
      const p = e.params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };
      this.seq = (this.seq + 1) >>> 0;
      const jpeg = Buffer.from(p.data, "base64");
      this.sink.sendBinary(encodePictureFrame(this.seq, Math.round(p.metadata.deviceWidth), Math.round(p.metadata.deviceHeight), jpeg));
      this.inFlight++;
      this.chromeUnacked++;
      this.chromeSession = p.sessionId;
      this.maybeAck();
    });
  }

  private chain: Promise<void> = Promise.resolve();

  /** Streams `sessionId` (a page) at `vp`; replaces whatever was streaming. Calls run one at a time. */
  start(sessionId: string, vp: Viewport): Promise<void> {
    return this.enqueue(() => this.startNow(sessionId, vp, true));
  }

  /**
   * Restarts the current stream so Chrome sends the page as it is now. The viewer's count of
   * undrawn pictures is kept: its acks for them are still on the way.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.sessionId && this.viewport) await this.startNow(this.sessionId, this.viewport, false);
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn);
    return this.chain;
  }

  private async startNow(sessionId: string, vp: Viewport, newViewer: boolean): Promise<void> {
    await this.stopCurrent();
    this.sessionId = sessionId;
    this.viewport = vp;
    if (newViewer) this.inFlight = 0;
    this.chromeUnacked = 0;
    this.lastAckAt = 0;
    const scale = Math.min(vp.dpr, 2);
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.opts().jpegQuality,
      maxWidth: Math.round(vp.cssWidth * scale),
      maxHeight: Math.round(vp.cssHeight * scale),
      everyNthFrame: 1,
    }, sessionId).catch(() => {});
  }

  /** The viewer drew picture `seq`. Older acks are counted the same: order is all that matters. */
  ack(_seq: number): void {
    if (this.inFlight > 0) this.inFlight--;
    this.maybeAck();
  }

  /** The person sent input to the page. */
  noteInput(): void {
    if (!this.sessionId) return;
    this.inputPending = true;
    if (this.chromeUnacked > 0) this.heldSinceInput = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), SETTLE_MS);
  }

  private settle(): void {
    this.settleTimer = null;
    const stale = this.heldSinceInput;
    this.inputPending = false;
    this.heldSinceInput = false;
    if (stale) void this.refresh();
  }

  private interval(): number {
    return 1000 / this.opts().fpsCap;
  }

  private hold(): void {
    if (this.inputPending) this.heldSinceInput = true;
  }

  private maybeAck(): void {
    if (this.chromeUnacked === 0 || this.sessionId === null) return;
    if (this.inFlight >= MAX_IN_FLIGHT) return this.hold();
    const now = Date.now();
    const wait = this.lastAckAt + this.interval() - now;
    if (wait > 0) {
      this.hold();
      this.schedule(wait);
      return;
    }
    this.chromeUnacked--;
    this.lastAckAt = now;
    void this.cdp.send("Page.screencastFrameAck", { sessionId: this.chromeSession }, this.sessionId).catch(() => {});
    if (this.chromeUnacked > 0) this.schedule(this.interval());
  }

  private schedule(ms: number): void {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.maybeAck(); }, ms);
  }

  private async stopCurrent(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const prev = this.sessionId;
    this.sessionId = null;
    if (prev) await this.cdp.send("Page.stopScreencast", {}, prev).catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    await this.stopCurrent();
  }

  dispose(): void {
    void this.stop();
    this.off();
  }
}
