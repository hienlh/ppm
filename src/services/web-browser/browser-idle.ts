/**
 * When PPM's Chrome may be stopped to give its memory back (0.3–1.3 GB measured on this host).
 *
 * An open socket is not a viewer: the tab pool keeps tabs of other projects mounted, and a
 * window behind another window still holds its socket. A viewer counts only while its window or
 * tab is visible, which the viewer reports with `visibility`. A visible window left alone for a
 * long time (a desk monitor nobody looks at) does not keep Chrome alive forever either.
 */

export interface IdleInput {
  now: number;
  idleStopMs: number;
  visibleViewers: number;
  /** Last moment a viewer was visible (now while one is). */
  lastVisibleAt: number;
  /** Last input from any viewer. */
  lastInputAt: number;
  /** Last call from an AI chat's browser tools. */
  lastAiAt: number;
}

/** A visible but untouched window keeps Chrome this many times longer, and at least an hour. */
export const VISIBLE_UNTOUCHED_FACTOR = 6;
const VISIBLE_UNTOUCHED_MIN_MS = 60 * 60_000;

export function idleDeadline(i: IdleInput): number {
  if (i.visibleViewers > 0) {
    const untouched = Math.max(i.idleStopMs * VISIBLE_UNTOUCHED_FACTOR, VISIBLE_UNTOUCHED_MIN_MS);
    return Math.max(i.lastInputAt, i.lastAiAt) + untouched;
  }
  return Math.max(i.lastVisibleAt, i.lastInputAt, i.lastAiAt) + i.idleStopMs;
}

export function shouldStopForIdle(i: IdleInput): boolean {
  return i.now >= idleDeadline(i);
}
