/**
 * Draws JPEG pictures onto a canvas, newest first: while one is being decoded, a later arrival
 * replaces any picture still waiting, so a slow device skips pictures rather than falling
 * behind. Each picture is acknowledged once drawn (or skipped), and that acknowledgement is what
 * lets the server send the next one (`screencast-pacer.ts`).
 *
 * `createImageBitmap` on a Blob works on plain-HTTP origins, unlike WebCodecs, so this is what
 * lets a phone on the LAN see the browser at all.
 */
import type { PictureFrame } from "../../../shared/web-browser-binary-frames";

export class FrameRenderer {
  private decoding = false;
  private waiting: PictureFrame | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** Layout size of the last picture drawn, in CSS px. */
  pageSize: { width: number; height: number } | null = null;
  /** Number of pictures drawn; read by tests and the stats line. */
  drawn = 0;

  constructor(private readonly ack: (seq: number) => void) {}

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
  }

  push(frame: PictureFrame): void {
    if (this.waiting) this.ack(this.waiting.seq); // skipped, but it counts as handled
    this.waiting = frame;
    if (!this.decoding) void this.drain();
  }

  private async drain(): Promise<void> {
    this.decoding = true;
    while (this.waiting) {
      const frame = this.waiting;
      this.waiting = null;
      try {
        const bitmap = await createImageBitmap(new Blob([frame.payload as BlobPart], { type: "image/jpeg" }));
        const canvas = this.canvas;
        if (canvas) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          this.pageSize = { width: frame.cssWidth, height: frame.cssHeight };
          this.drawn++;
        }
        bitmap.close();
      } catch {
        // A truncated JPEG is dropped; the next picture repaints everything.
      }
      this.ack(frame.seq);
    }
    this.decoding = false;
  }
}
