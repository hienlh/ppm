/**
 * How a fixed-size device frame sits in the canvas pane.
 *
 * The frame keeps its own CSS size — a phone design must lay out at 390px, not at the pane's
 * width — and is scaled with a transform to fit. It is never scaled *up*: enlarging a 390px
 * layout on a wide pane would show it bigger than any phone ever will.
 */

export interface Size {
  width: number;
  height: number;
}

export interface FrameFit {
  /** The frame's CSS size, i.e. what the design lays out against. */
  width: number;
  height: number;
  /** The transform scale that fits it into the pane. */
  scale: number;
  /** The frame's footprint on screen after scaling. */
  outerWidth: number;
  outerHeight: number;
}

/** Room left around a scaled frame so its edge stays visible against the canvas. */
export const FRAME_PADDING = 16;
/** Below this a frame is unreadable anyway; stops a collapsed pane from producing 0 or NaN. */
export const MIN_FRAME_SCALE = 0.05;

export function fitFrame(frame: Size | null, pane: Size, padding = FRAME_PADDING): FrameFit {
  const paneW = Math.max(0, finite(pane.width));
  const paneH = Math.max(0, finite(pane.height));
  if (!frame) {
    return { width: paneW, height: paneH, scale: 1, outerWidth: paneW, outerHeight: paneH };
  }
  const width = Math.max(1, finite(frame.width));
  const height = Math.max(1, finite(frame.height));
  const availW = Math.max(0, paneW - 2 * padding);
  const availH = Math.max(0, paneH - 2 * padding);
  const raw = Math.min(1, availW / width, availH / height);
  const scale = Math.max(MIN_FRAME_SCALE, Number.isFinite(raw) ? raw : 1);
  return { width, height, scale, outerWidth: width * scale, outerHeight: height * scale };
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}
