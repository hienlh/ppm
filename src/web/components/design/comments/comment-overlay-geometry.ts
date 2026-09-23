import type { FrameFit, Size } from "../canvas/canvas-geometry";
import type { BridgeRect } from "../../../../shared/design-bridge-messages-picker";

/**
 * From a rect the frame reported (its own viewport's CSS pixels) to a position in the canvas
 * stage, where pins and the element action bar are drawn.
 *
 * The frame is laid out at its own size and scaled to fit, centred in the stage, so a point
 * inside it lands at `frameOrigin + point × scale`. Pins and bars stay at their real size
 * rather than being scaled with the frame — a 44px touch target must stay 44px.
 */

export interface StagePoint {
  left: number;
  top: number;
}

export function frameOrigin(fit: FrameFit, stage: Size): StagePoint {
  return { left: (stage.width - fit.outerWidth) / 2, top: (stage.height - fit.outerHeight) / 2 };
}

/** Whether any of the element is inside the frame's viewport. */
export function rectVisible(rect: BridgeRect, fit: FrameFit): boolean {
  return rect.x + rect.w > 0 && rect.y + rect.h > 0 && rect.x < fit.width && rect.y < fit.height;
}

/** The centre of a pin at the element's top-right corner, kept `inset` px inside the frame. */
export function pinCenter(rect: BridgeRect, fit: FrameFit, stage: Size, inset = 14): StagePoint {
  const o = frameOrigin(fit, stage);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    left: clamp(o.left + (rect.x + rect.w) * fit.scale, o.left + inset, o.left + fit.outerWidth - inset),
    top: clamp(o.top + rect.y * fit.scale, o.top + inset, o.top + fit.outerHeight - inset),
  };
}

/**
 * Top-left of a floating bar beside the element: below it when there is room, above it
 * otherwise, and kept inside the stage.
 */
export function barPosition(rect: BridgeRect, fit: FrameFit, stage: Size, bar: Size, gap = 8): StagePoint {
  const o = frameOrigin(fit, stage);
  const left = o.left + rect.x * fit.scale;
  const top = o.top + rect.y * fit.scale;
  const bottom = o.top + (rect.y + rect.h) * fit.scale;
  const below = bottom + gap;
  const y = below + bar.height <= stage.height ? below : Math.max(gap, top - gap - bar.height);
  const x = Math.min(Math.max(gap, left), Math.max(gap, stage.width - bar.width - gap));
  return { left: x, top: Math.min(y, Math.max(gap, stage.height - bar.height - gap)) };
}
