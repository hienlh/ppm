/**
 * Drag and drop in MOUSE mode, as Windows App does it: tap, then put the finger back down
 * within `DOUBLE_TAP_WINDOW_MS` and drag. The left button goes down at the cursor where the
 * second touch started and comes up where the finger lifts, so a file, a window or a text
 * selection follows the virtual cursor. A plain one-finger drag still only moves the cursor.
 *
 * The press is held back until `DOUBLE_CLICK_GUARD_MS` after the tap's own click. Sent sooner,
 * the host reads the tap's click and the drag's press as a double click (Windows' default
 * double-click time is 500 ms), and Explorer opens the file instead of dragging it. Until the
 * press goes out the cursor moves on the phone only; the press then goes down at the start
 * point and the host cursor jumps to where the finger has got to.
 */
import type { Fraction } from "./remote-desktop-coords";

/** The second touch must start this soon after the tap's finger lifted. */
export const DOUBLE_TAP_WINDOW_MS = 300;
/** The drag's press waits this long after the tap's click, longer than Windows' 500 ms. */
export const DOUBLE_CLICK_GUARD_MS = 550;

export interface DoubleTapDrag {
  /** The cursor when the second touch started: where the left button goes down. */
  startCursor: Fraction;
  /** `performance.now()` time before which the press must not be sent. */
  earliestDownAt: number;
  downSent: boolean;
}

/** A drag candidate for a touch starting at `now`, or null when it is not a second touch soon
 *  enough after a left-click tap. */
export function beginDoubleTapDrag(
  lastLeftTapEndAt: number | null,
  now: number,
  cursor: Fraction,
): DoubleTapDrag | null {
  if (lastLeftTapEndAt === null || now - lastLeftTapEndAt > DOUBLE_TAP_WINDOW_MS) return null;
  return { startCursor: cursor, earliestDownAt: lastLeftTapEndAt + DOUBLE_CLICK_GUARD_MS, downSent: false };
}

/** The left button going down at the drag's start, then the host cursor catching up with the
 *  virtual one (which may already have moved on the phone). */
export function pressDragButton(drag: DoubleTapDrag, cursor: Fraction): Record<string, unknown>[] {
  if (drag.downSent) return [];
  drag.downSent = true;
  return [
    { type: "pointer", xFrac: drag.startCursor.xFrac, yFrac: drag.startCursor.yFrac, button: "left", down: true },
    { type: "pointer", xFrac: cursor.xFrac, yFrac: cursor.yFrac, button: null, down: null },
  ];
}

/** Ends a drag that moved: the press if it has not gone out yet, then the release at the cursor. */
export function releaseDragButton(drag: DoubleTapDrag, cursor: Fraction): Record<string, unknown>[] {
  return [
    ...pressDragButton(drag, cursor),
    { type: "pointer", xFrac: cursor.xFrac, yFrac: cursor.yFrac, button: "left", down: false },
  ];
}

/** How long the hook should wait before pressing, 0 when it may press at once. */
export function dragPressDelay(drag: DoubleTapDrag, now: number): number {
  return Math.max(0, drag.earliestDownAt - now);
}

