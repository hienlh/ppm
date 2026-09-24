/**
 * A slide deck as the design bridge measured it in the browser, on its way to the PPTX writer.
 *
 * The bridge reads positions and computed styles off the live canvas (the user's browser is
 * the renderer), so everything here is in CSS pixels relative to the slide's top-left corner.
 * It is untrusted like every frame message: a page script can post the same shape, so
 * `parseSlideDoc` (design-slide-doc-parse.ts) caps every count, string and number, accepts
 * colours only as six hex digits and images only as PNG/JPEG data URLs, and bounds the total
 * image payload, using the limits below.
 */

export interface SlideColor {
  /** `RRGGBB`, uppercase. */
  hex: string;
  /** 0 (transparent) to 1 (opaque). */
  alpha: number;
}

export interface SlideTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: SlideColor;
  /** Font size in CSS px. */
  sizePx?: number;
  /** The first family of the computed `font-family`, unquoted. */
  font?: string;
  /** A line break follows this run. */
  breakLine?: boolean;
}

export interface SlideBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise degrees. */
  rotation?: number;
}

export type SlideTextAlign = "left" | "center" | "right" | "justify";
export type SlideTextValign = "top" | "middle" | "bottom";

export interface SlideTextItem extends SlideBox {
  kind: "text";
  runs: SlideTextRun[];
  align: SlideTextAlign;
  valign: SlideTextValign;
  lineHeightPx?: number;
  bullet?: "bullet" | "number";
}

export interface SlideShapeItem extends SlideBox {
  kind: "shape";
  fill?: SlideColor;
  border?: { widthPx: number; color: SlideColor };
  radiusPx?: number;
}

export interface SlideImageItem extends SlideBox {
  kind: "image";
  /** `data:image/png;base64,…` or `data:image/jpeg;base64,…`. */
  data: string;
}

export type SlideItem = SlideTextItem | SlideShapeItem | SlideImageItem;

export interface Slide {
  background?: SlideColor;
  items: SlideItem[];
}

export interface SlideDoc {
  /** Slide size in CSS px (1280x720 for a standard deck). */
  width: number;
  height: number;
  slides: Slide[];
  /** What could not be reproduced exactly, one line each, already naming the slide. */
  warnings: string[];
}

export const MAX_SLIDES = 200;
export const MAX_SLIDE_ITEMS = 600;
export const MAX_TEXT_RUNS = 400;
export const MAX_RUN_TEXT = 5000;
export const MAX_SLIDE_WARNINGS = 200;
/** Total size of every image data URL in one deck. */
export const MAX_SLIDE_IMAGE_BYTES = 50 * 1024 * 1024;
/** Largest slide edge, in px: PowerPoint's own limit is 56 inches. */
export const MAX_SLIDE_EDGE_PX = 5376;
