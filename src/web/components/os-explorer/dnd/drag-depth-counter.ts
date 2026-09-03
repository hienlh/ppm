/**
 * A drag-enter/leave depth counter shared by every hand-rolled dragenter/dragleave pair in
 * the explorer and the project tree: nested children fire their own enter/leave pairs, so
 * only a balanced count means "actually left". Both `enter` and `leave` take the same
 * `accepted` gate the caller already computed for its own drag kind — a leave that forgot to
 * apply that gate the way its own enter did is exactly what drove a counter negative and left
 * a highlight that could never turn on again (a drag kind that never incremented the counter
 * still decremented it on its way out).
 */

export interface DragDepthCounter {
  current: number;
}

/** True the moment the count crosses from 0 to 1 — start showing the highlight. */
export function enterDragDepth(counter: DragDepthCounter, accepted: boolean): boolean {
  if (!accepted) return false;
  counter.current++;
  return counter.current === 1;
}

/**
 * True once the count returns to 0 — stop showing the highlight. Clamped at 0 rather than
 * trusting every caller's enter/leave pairing to be perfectly balanced; going negative would
 * otherwise require more than one matching `enter` before the count could ever reach 0 again.
 */
export function leaveDragDepth(counter: DragDepthCounter, accepted: boolean): boolean {
  if (!accepted) return false;
  counter.current = Math.max(0, counter.current - 1);
  return counter.current === 0;
}

/** Resets after a drop or cancel, when the browser will not send the matching leave. */
export function resetDragDepth(counter: DragDepthCounter): void {
  counter.current = 0;
}
