/**
 * Geometry and formatting for the Read-tool image result panel.
 *
 * The tile's aspect ratio follows the image so nothing is cropped, but only within a
 * clamp: very tall captures would become unreadable slivers, and panoramas would waste
 * the width they could use.
 */

export const TILE_MIN_RATIO = 0.62;
export const TILE_MAX_RATIO = 2.4;

/**
 * Tile width in px; the narrow value applies under a 470px container.
 *
 * The rendered widths come from Tailwind classes in tool-image-preview.tsx, which cannot
 * read these constants — change both together. Layout is computed at the wide width, and
 * a native-size image that no longer fits the narrow tile is capped by the box rather than
 * overflowing it, so the two staying in sync only affects which images read as native.
 */
export const TILE_WIDTH = 132;
export const TILE_WIDTH_NARROW = 64;

export interface NaturalSize {
  w: number;
  h: number;
}

export type ImageFit =
  /** Box matches the image, so cover crops nothing. */
  | "cover"
  /** Taller than the clamp: fit inside the box on the checkerboard. */
  | "contain"
  /** Smaller than the box: native size, centered, never upscaled. */
  | "native";

export interface PreviewLayout {
  /** `band` drops the two-column split for panoramas. */
  variant: "split" | "band";
  /** width / height of the rendered box. */
  aspect: number;
  fit: ImageFit;
}

export function previewLayout(natural: NaturalSize, tileWidth: number): PreviewLayout {
  const ratio = natural.w / natural.h;

  if (ratio > TILE_MAX_RATIO) {
    return { variant: "band", aspect: ratio, fit: "contain" };
  }

  const aspect = Math.max(TILE_MIN_RATIO, ratio);
  const boxHeight = tileWidth / aspect;
  if (natural.w < tileWidth && natural.h < boxHeight) {
    return { variant: "split", aspect, fit: "native" };
  }

  return { variant: "split", aspect, fit: ratio < TILE_MIN_RATIO ? "contain" : "cover" };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function dimensionsLabel(natural: NaturalSize, fit: ImageFit): string {
  const base = `${natural.w} × ${natural.h} px`;
  return fit === "native" ? `${base} · shown 1:1` : base;
}

/**
 * Natural sizes survive unmount so a card that scrolls out and back does not resolve
 * its height a second time — a late height change mid-transcript jumps the scroll.
 */
const naturalSizes = new Map<string, NaturalSize>();

export function getCachedNatural(path: string): NaturalSize | undefined {
  return naturalSizes.get(path);
}

export function cacheNatural(path: string, size: NaturalSize): void {
  naturalSizes.set(path, size);
}
