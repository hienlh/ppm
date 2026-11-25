/**
 * How large the pictures are while the person scrolls: smaller only when the link cannot carry
 * full-size ones fast enough, full size again once they stop.
 *
 * Bytes per picture relative to full size, measured on a news page and on vnexpress.net (1440 px
 * wide at JPEG 55): 0.75 of the width → 0.57, half → 0.29. On 5 Mbit/s half-size pictures took
 * scrolling from 8.3 to 12.1 pictures a second.
 */

export const SCALE_STEPS = [1, 0.75, 0.5] as const;
export type ScreencastScale = (typeof SCALE_STEPS)[number];

const BYTES_RATIO: Record<ScreencastScale, number> = { 1: 1, 0.75: 0.57, 0.5: 0.29 };

/** Scrolling below this many pictures a second reads as jerky; aim for it before sharpness. */
export const SCROLL_TARGET_FPS = 12;

export interface ScaleInput {
  /** The person is scrolling (wheel or finger) right now. */
  moving: boolean;
  /** Full-size pictures a second the link carries; null while unknown. */
  linkFps: number | null;
  /** The stream's ceiling. */
  capFps: number;
}

export function chooseScale({ moving, linkFps, capFps }: ScaleInput): ScreencastScale {
  if (!moving || linkFps === null) return 1;
  const target = Math.min(capFps, SCROLL_TARGET_FPS);
  for (const k of SCALE_STEPS) {
    if (linkFps / BYTES_RATIO[k] >= target) return k;
  }
  return 0.5;
}
