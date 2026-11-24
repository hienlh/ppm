/**
 * Pictures of the tab on screen, sent to the one viewer in control, at a pace the viewer sets.
 *
 * Chrome sends the next screencast frame only after the previous one is acknowledged, so the
 * acknowledgement is the throttle. It is sent once two things hold: fewer than
 * `MAX_IN_FLIGHT` pictures are still unacknowledged by the viewer (its `frame.ack` after it has
 * drawn one), and `1000 / fpsCap` ms have passed since the last picture. A slow link therefore
 * slows the stream down instead of queueing pictures in PPM — the socket's own buffered amount
 * cannot be the signal, because Bun's barely ever grows (CLAUDE.md, "Reacting to a backpressure
 * spike"). Two in flight rather than one, or a relayed link would cap the rate at one picture
 * per round trip.
 */
import type { CdpConnection } from "./cdp-connection.ts";
import { encodePictureFrame } from "../../shared/web-browser-binary-frames.ts";
import type { Viewport } from "./input-bridge.ts";

export const MAX_IN_FLIGHT = 2;

export interface PacerSink {
  sendBinary(bytes: Uint8Array): void;
}

export class ScreencastPacer {
  private sessionId: string | null = null;
  private seq = 0;
  private inFlight = 0;
  private lastSentAt = 0;
  private pendingAck: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
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
      this.lastSentAt = Date.now();
      this.pendingAck = p.sessionId;
      this.maybeAck();
    });
  }

  private chain: Promise<void> = Promise.resolve();

  /** Streams `sessionId` (a page) at `vp`; replaces whatever was streaming. Calls run one at a time. */
  start(sessionId: string, vp: Viewport): Promise<void> {
    this.chain = this.chain.then(() => this.startNow(sessionId, vp), () => this.startNow(sessionId, vp));
    return this.chain;
  }

  private async startNow(sessionId: string, vp: Viewport): Promise<void> {
    await this.stopCurrent();
    this.sessionId = sessionId;
    this.inFlight = 0;
    this.pendingAck = null;
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

  private maybeAck(): void {
    if (this.pendingAck === null || this.sessionId === null || this.inFlight >= MAX_IN_FLIGHT) return;
    const wait = this.lastSentAt + 1000 / this.opts().fpsCap - Date.now();
    if (wait > 0) {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.maybeAck(); }, wait);
      return;
    }
    const frameSession = this.pendingAck;
    this.pendingAck = null;
    void this.cdp.send("Page.screencastFrameAck", { sessionId: frameSession }, this.sessionId).catch(() => {});
  }

  private async stopCurrent(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const prev = this.sessionId;
    this.sessionId = null;
    if (prev) await this.cdp.send("Page.stopScreencast", {}, prev).catch(() => {});
  }

  async stop(): Promise<void> {
    await this.stopCurrent();
  }

  dispose(): void {
    void this.stopCurrent();
    this.off();
  }
}
