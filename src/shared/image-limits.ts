/**
 * The per-image dimension ceiling the API applies, and the arithmetic for staying under it.
 *
 * Shared because both ends of the pipeline need the same number: the browser downscales an
 * attachment before it is ever uploaded, and the transcript tooling reports on images that
 * slipped in from elsewhere (another client, an older build) still carrying the full size.
 */

/**
 * Longest side, in pixels, at which the API starts refusing an image once a request carries
 * several of them. The value is a ceiling, so an image measuring exactly this is already over
 * it — comparisons are `>=`, and a downscale targets strictly below.
 */
export const MAX_IMAGE_DIMENSION = 2000;

/**
 * Dimensions that bring an image under the cap, or null when it is already small enough.
 *
 * Scales the longest side to one pixel below the cap and takes the other side with it, so the
 * aspect ratio survives and the result cannot land back on the boundary through rounding.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_IMAGE_DIMENSION,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const longest = Math.max(width, height);
  if (longest < max) return null;

  const target = max - 1;
  const scale = target / longest;
  return {
    width: width >= height ? target : Math.max(1, Math.round(width * scale)),
    height: height > width ? target : Math.max(1, Math.round(height * scale)),
  };
}
