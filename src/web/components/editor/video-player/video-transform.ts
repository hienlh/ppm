/**
 * Rotation/flip state for the video player, applied as a CSS transform.
 *
 * Camera files are often recorded sideways (dashcams, phones) and carry no rotation
 * metadata, so the viewer needs a manual fix. Kept as pure functions so the layout
 * math is testable without a DOM.
 */

export interface VideoTransform {
  /** Clockwise degrees, one of 0 / 90 / 180 / 270. */
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

export const IDENTITY_TRANSFORM: VideoTransform = { rotation: 0, flipH: false, flipV: false };

export function rotateClockwise(t: VideoTransform): VideoTransform {
  return { ...t, rotation: ((t.rotation + 90) % 360) as VideoTransform["rotation"] };
}

export function rotateCounterClockwise(t: VideoTransform): VideoTransform {
  return { ...t, rotation: ((t.rotation + 270) % 360) as VideoTransform["rotation"] };
}

export function isIdentity(t: VideoTransform): boolean {
  return t.rotation === 0 && !t.flipH && !t.flipV;
}

/** CSS `transform` value. Flip is applied in the video's own axes, before rotation. */
export function toCssTransform(t: VideoTransform): string {
  const parts: string[] = [];
  if (t.rotation) parts.push(`rotate(${t.rotation}deg)`);
  if (t.flipH) parts.push("scaleX(-1)");
  if (t.flipV) parts.push("scaleY(-1)");
  return parts.length ? parts.join(" ") : "none";
}

/**
 * Size the element must be laid out at so that, once rotated, it fits `box`.
 * A 90°/270° rotation swaps the visual axes, so the element's width is limited by
 * the box's height and vice versa. Returns max-width/max-height in CSS pixels.
 */
export function fittedMaxSize(t: VideoTransform, box: { width: number; height: number }): { maxWidth: number; maxHeight: number } {
  const swapped = t.rotation === 90 || t.rotation === 270;
  return swapped
    ? { maxWidth: box.height, maxHeight: box.width }
    : { maxWidth: box.width, maxHeight: box.height };
}
