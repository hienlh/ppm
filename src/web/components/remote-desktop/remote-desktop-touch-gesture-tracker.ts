/**
 * Pure(-ish) per-gesture accumulators for `use-remote-desktop-touch.ts` — kept out of the hook
 * so the DOM-wiring there stays readable and these decision rules live in one place. Each
 * `track` object is created on touchstart and mutated by the `advance*`/`resolve*` functions as
 * touchmove/touchend events arrive; nothing here touches the DOM or sends messages directly,
 * the hook does that with whatever these functions return.
 */
import { classifyTwoFingerGesture, isTapGesture, touchDistance, touchMidpoint, type PointerSample } from "./remote-desktop-gesture-classifiers";
import { fractionFromZoomedPoint, type ZoomPanTransform, type Fraction } from "./remote-desktop-coords";

export type RemoteDesktopInputMode = "touch" | "mouse";

export const TAP_MOVE_THRESHOLD_PX = 10;
export const TAP_MAX_DURATION_MS = 300;
export const TWO_FINGER_THRESHOLD_PX = 15;
export const SCALE_MIN = 1;
export const SCALE_MAX = 4;

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function clickMessages(xFrac: number, yFrac: number, button: "left" | "right"): Record<string, unknown>[] {
  return [
    { type: "pointer", xFrac, yFrac, button, down: true },
    { type: "pointer", xFrac, yFrac, button, down: false },
  ];
}

/* ------------------------------------------------------------------ */
/*  Single-finger tracking                                             */
/* ------------------------------------------------------------------ */

export interface SingleTrack {
  start: PointerSample;
  last: { x: number; y: number };
  moved: boolean;
  /** The container's bounding rect at gesture start — cached because it does not change mid-drag. */
  rect: DOMRect;
}

export function beginSingleTouch(x: number, y: number, rect: DOMRect): SingleTrack {
  return { start: { x, y, t: performance.now() }, last: { x, y }, moved: false, rect };
}

export interface SingleMoveResult {
  /** Pointer message to send immediately (touch mode: drag-start once, then drag-move). */
  message?: Record<string, unknown>;
  /** New virtual-cursor fraction (mouse mode only). */
  cursor?: Fraction;
  sendCursorMove?: boolean;
}

export function advanceSingleTouch(
  track: SingleTrack,
  x: number,
  y: number,
  mode: RemoteDesktopInputMode,
  transform: ZoomPanTransform,
  cursor: Fraction,
): SingleMoveResult {
  const dist = Math.hypot(x - track.start.x, y - track.start.y);
  if (mode === "touch") {
    if (!track.moved && dist > TAP_MOVE_THRESHOLD_PX) {
      track.moved = true;
      const start = fractionFromZoomedPoint(track.start.x, track.start.y, track.rect, transform);
      track.last = { x, y };
      return { message: { type: "pointer", xFrac: start.xFrac, yFrac: start.yFrac, button: "left", down: true } };
    }
    track.last = { x, y };
    if (!track.moved) return {};
    const frac = fractionFromZoomedPoint(x, y, track.rect, transform);
    return { message: { type: "pointer", xFrac: frac.xFrac, yFrac: frac.yFrac, button: null, down: null } };
  }

  // Mouse mode: relative drag of the client-side virtual cursor, scaled down by zoom so panning
  // while zoomed in still moves the cursor the same *host* distance.
  const dx = (x - track.last.x) / transform.scale;
  const dy = (y - track.last.y) / transform.scale;
  if (dist > TAP_MOVE_THRESHOLD_PX) track.moved = true;
  track.last = { x, y };
  const next: Fraction = {
    xFrac: clamp(cursor.xFrac + dx / track.rect.width, 0, 1),
    yFrac: clamp(cursor.yFrac + dy / track.rect.height, 0, 1),
  };
  return { cursor: next, sendCursorMove: true };
}

export function resolveSingleTouchEnd(
  track: SingleTrack,
  x: number,
  y: number,
  mode: RemoteDesktopInputMode,
  transform: ZoomPanTransform,
  cursor: Fraction,
): Record<string, unknown>[] {
  const end: PointerSample = { x, y, t: performance.now() };
  const tapped = isTapGesture(track.start, end, TAP_MOVE_THRESHOLD_PX, TAP_MAX_DURATION_MS);
  if (mode === "touch") {
    const frac = fractionFromZoomedPoint(x, y, track.rect, transform);
    if (!track.moved && tapped) return clickMessages(frac.xFrac, frac.yFrac, "left");
    if (track.moved) return [{ type: "pointer", xFrac: frac.xFrac, yFrac: frac.yFrac, button: "left", down: false }];
    return [];
  }
  if (!track.moved && tapped) return clickMessages(cursor.xFrac, cursor.yFrac, "left");
  return [];
}

/* ------------------------------------------------------------------ */
/*  Two-finger tracking                                                 */
/* ------------------------------------------------------------------ */

export interface TwoFingerTrack {
  startDistance: number;
  startMid: { x: number; y: number };
  lastMid: { x: number; y: number };
  startScale: number;
  startTime: number;
  gesture: "pinch" | "scroll" | null;
}

export function beginTwoFingerTouch(
  pa: { x: number; y: number },
  pb: { x: number; y: number },
  currentScale: number,
): TwoFingerTrack {
  const mid = touchMidpoint(pa, pb);
  return {
    startDistance: touchDistance(pa, pb),
    startMid: mid,
    lastMid: mid,
    startScale: currentScale,
    startTime: performance.now(),
    gesture: null,
  };
}

export interface TwoFingerMoveResult {
  transform?: ZoomPanTransform;
  wheelDeltaPx?: number;
}

/** Locks in "pinch" vs "scroll" the first time either signal (finger spread, or midpoint
 *  translation) crosses `TWO_FINGER_THRESHOLD_PX`, then keeps applying that gesture for the
 *  rest of the touch — see `remote-desktop-gesture-classifiers.ts` for why. */
export function advanceTwoFingerTouch(
  track: TwoFingerTrack,
  pa: { x: number; y: number },
  pb: { x: number; y: number },
  currentTransform: ZoomPanTransform,
): TwoFingerMoveResult {
  const currentDistance = touchDistance(pa, pb);
  const currentMid = touchMidpoint(pa, pb);

  if (track.gesture === null) {
    const distDiff = Math.abs(currentDistance - track.startDistance);
    const midDist = touchDistance(track.startMid, currentMid);
    if (distDiff > TWO_FINGER_THRESHOLD_PX) {
      track.gesture = classifyTwoFingerGesture(track.startDistance, currentDistance, TWO_FINGER_THRESHOLD_PX);
    } else if (midDist > TWO_FINGER_THRESHOLD_PX) {
      track.gesture = "scroll";
    } else {
      track.lastMid = currentMid;
      return {}; // still ambiguous — wait for more movement before committing
    }
  }

  let result: TwoFingerMoveResult;
  if (track.gesture === "pinch") {
    const scale = clamp(track.startScale * (currentDistance / track.startDistance), SCALE_MIN, SCALE_MAX);
    result = { transform: { scale, panX: currentTransform.panX, panY: currentTransform.panY } };
  } else if (currentTransform.scale > 1.01) {
    // Panning only makes sense once zoomed in — at scale 1 the same drag scrolls instead.
    const dx = currentMid.x - track.lastMid.x;
    const dy = currentMid.y - track.lastMid.y;
    result = { transform: { scale: currentTransform.scale, panX: currentTransform.panX + dx, panY: currentTransform.panY + dy } };
  } else {
    result = { wheelDeltaPx: currentMid.y - track.lastMid.y };
  }
  track.lastMid = currentMid;
  return result;
}

export function resolveTwoFingerEnd(
  track: TwoFingerTrack,
  rect: DOMRect,
  transform: ZoomPanTransform,
): Record<string, unknown>[] {
  if (track.gesture === null && performance.now() - track.startTime <= TAP_MAX_DURATION_MS) {
    const frac = fractionFromZoomedPoint(track.lastMid.x, track.lastMid.y, rect, transform);
    return clickMessages(frac.xFrac, frac.yFrac, "right");
  }
  return [];
}
