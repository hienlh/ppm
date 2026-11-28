/**
 * Keeps the virtual cursor on screen while zoomed in, the way TeamViewer and Windows App do:
 * once Mouse mode drags the cursor within `edgeMarginPx` of an edge of the view, the zoomed
 * picture slides under it so the cursor stays that far inside. Without this the cursor walked
 * off the visible part of the desktop and the user had to stop and pan with two fingers.
 *
 * Pure arithmetic over the same model `fractionFromZoomedPoint` uses: the stage is scaled about
 * the container's centre, then translated by `panX/panY`, and the video is letterboxed inside
 * the container with the same centre.
 */
import type { Fraction, Rect, ZoomPanTransform } from "./remote-desktop-coords";

/** How close to an edge of the view the cursor may come before the picture follows it. */
export const FOLLOW_EDGE_MARGIN_PX = 48;

function axis(
  pan: number,
  frac: number,
  videoStart: number,
  videoSize: number,
  boxStart: number,
  boxSize: number,
  scale: number,
  margin: number,
): number {
  const centre = boxStart + boxSize / 2;
  const base = videoStart + frac * videoSize;
  const onScreen = centre + pan + (base - centre) * scale;
  // A view too small for two margins keeps the cursor anywhere in its middle half instead.
  const m = Math.min(margin, boxSize / 4);
  const lo = boxStart + m;
  const hi = boxStart + boxSize - m;
  let next = pan;
  if (onScreen < lo) next = pan + (lo - onScreen);
  else if (onScreen > hi) next = pan + (hi - onScreen);
  if (next === pan) return pan;
  // Never slide the picture's edge past the view's edge: at the desktop's own edge the cursor
  // sits at the edge of the view. A pan the user already took further than that is not undone.
  const overflow = Math.abs((videoSize * scale) / 2 - boxSize / 2);
  const min = Math.min(-overflow, pan);
  const max = Math.max(overflow, pan);
  return Math.min(Math.max(next, min), max);
}

/**
 * The transform that keeps `cursor` (a fraction of the capture) inside the view. `video` is the
 * letterboxed video rect and `box` the container rect, both at rest (`scale=1, pan=0`). Returns
 * `transform` itself when nothing needs to move, so callers can compare by identity.
 */
export function followCursor(
  transform: ZoomPanTransform,
  cursor: Fraction,
  video: Rect,
  box: Rect,
  edgeMarginPx = FOLLOW_EDGE_MARGIN_PX,
): ZoomPanTransform {
  if (transform.scale <= 1) return transform; // the whole desktop is already in view
  const panX = axis(transform.panX, cursor.xFrac, video.left, video.width, box.left, box.width, transform.scale, edgeMarginPx);
  const panY = axis(transform.panY, cursor.yFrac, video.top, video.height, box.top, box.height, transform.scale, edgeMarginPx);
  if (panX === transform.panX && panY === transform.panY) return transform;
  return { scale: transform.scale, panX, panY };
}
