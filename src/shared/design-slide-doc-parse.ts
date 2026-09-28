import {
  MAX_RUN_TEXT, MAX_SLIDE_EDGE_PX, MAX_SLIDE_IMAGE_BYTES, MAX_SLIDE_ITEMS, MAX_SLIDE_WARNINGS, MAX_SLIDES, MAX_TEXT_RUNS,
  type Slide, type SlideBox, type SlideColor, type SlideDoc, type SlideItem, type SlideShapeItem, type SlideTextAlign,
  type SlideTextItem, type SlideTextRun, type SlideTextValign,
} from "./design-slide-doc";

/**
 * The one validator a measured deck passes before anything of it reaches the PPTX writer.
 * One malformed item anywhere rejects the whole document: the frame is untrusted, and a
 * partial deck would silently drop content the user expects to see.
 */

const MAX_COORD = 100_000;

const HEX_RE = /^[0-9A-F]{6}$/;
const FONT_RE = /^[\p{L}\p{N} ._-]{1,64}$/u;
const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const ALIGNS: readonly SlideTextAlign[] = ["left", "center", "right", "justify"];
const VALIGNS: readonly SlideTextValign[] = ["top", "middle", "bottom"];

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown, max = MAX_COORD): number | null =>
  (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max ? v : null);

export function parseSlideColor(v: unknown): SlideColor | null {
  if (!isRaw(v) || typeof v.hex !== "string" || !HEX_RE.test(v.hex)) return null;
  const alpha = finite(v.alpha, 1);
  return alpha === null || alpha < 0 ? null : { hex: v.hex, alpha };
}

function parseBox(v: Raw): SlideBox | null {
  const x = finite(v.x), y = finite(v.y), w = finite(v.w), h = finite(v.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  const box: SlideBox = { x, y, w, h };
  if (v.rotation !== undefined) {
    const r = finite(v.rotation, 360);
    if (r === null) return null;
    if (r !== 0) box.rotation = r;
  }
  return box;
}

function parseRun(v: unknown): SlideTextRun | null {
  if (!isRaw(v) || typeof v.text !== "string") return null;
  const run: SlideTextRun = { text: v.text.slice(0, MAX_RUN_TEXT) };
  for (const flag of ["bold", "italic", "underline", "breakLine"] as const) {
    if (v[flag] === true) run[flag] = true;
  }
  if (v.color !== undefined) {
    const color = parseSlideColor(v.color);
    if (!color) return null;
    run.color = color;
  }
  if (v.sizePx !== undefined) {
    const size = finite(v.sizePx, 4000);
    if (size === null || size <= 0) return null;
    run.sizePx = size;
  }
  // A font name the pattern does not allow is dropped rather than refusing the run:
  // PowerPoint then uses its default face, which is what a missing font does anyway.
  if (typeof v.font === "string" && FONT_RE.test(v.font)) run.font = v.font;
  return run;
}

function parseItem(v: unknown, budget: { imageBytes: number }): SlideItem | null {
  if (!isRaw(v)) return null;
  const box = parseBox(v);
  if (!box) return null;
  if (v.kind === "text") {
    if (!Array.isArray(v.runs) || v.runs.length === 0 || v.runs.length > MAX_TEXT_RUNS) return null;
    const runs = v.runs.map(parseRun);
    if (runs.some((r) => r === null)) return null;
    const align = ALIGNS.find((a) => a === v.align);
    const valign = VALIGNS.find((a) => a === v.valign);
    if (!align || !valign) return null;
    const item: SlideTextItem = { kind: "text", ...box, runs: runs as SlideTextRun[], align, valign };
    const lh = v.lineHeightPx === undefined ? undefined : finite(v.lineHeightPx, 4000);
    if (lh === null || (lh !== undefined && lh <= 0)) return null;
    if (lh !== undefined) item.lineHeightPx = lh;
    if (v.bullet === "bullet" || v.bullet === "number") item.bullet = v.bullet;
    return item;
  }
  if (v.kind === "shape") {
    const item: SlideShapeItem = { kind: "shape", ...box };
    if (v.fill !== undefined) {
      const fill = parseSlideColor(v.fill);
      if (!fill) return null;
      item.fill = fill;
    }
    if (v.border !== undefined) {
      if (!isRaw(v.border)) return null;
      const width = finite(v.border.widthPx, 1000);
      const color = parseSlideColor(v.border.color);
      if (width === null || width <= 0 || !color) return null;
      item.border = { widthPx: width, color };
    }
    if (v.radiusPx !== undefined) {
      const r = finite(v.radiusPx);
      if (r === null || r < 0) return null;
      if (r > 0) item.radiusPx = r;
    }
    return item.fill || item.border ? item : null;
  }
  if (v.kind === "image") {
    if (typeof v.data !== "string" || v.data.length > MAX_SLIDE_IMAGE_BYTES - budget.imageBytes) return null;
    if (!IMAGE_DATA_RE.test(v.data)) return null;
    budget.imageBytes += v.data.length;
    return { kind: "image", ...box, data: v.data };
  }
  return null;
}

/** A validated deck, or null. One malformed item anywhere rejects the whole document. */
export function parseSlideDoc(v: unknown): SlideDoc | null {
  if (!isRaw(v)) return null;
  const width = finite(v.width, MAX_SLIDE_EDGE_PX), height = finite(v.height, MAX_SLIDE_EDGE_PX);
  if (width === null || height === null || width < 1 || height < 1) return null;
  if (!Array.isArray(v.slides) || v.slides.length === 0 || v.slides.length > MAX_SLIDES) return null;
  if (!Array.isArray(v.warnings) || v.warnings.length > MAX_SLIDE_WARNINGS) return null;
  if (!v.warnings.every((w) => typeof w === "string")) return null;
  const budget = { imageBytes: 0 };
  const slides: Slide[] = [];
  for (const raw of v.slides) {
    if (!isRaw(raw) || !Array.isArray(raw.items) || raw.items.length > MAX_SLIDE_ITEMS) return null;
    const slide: Slide = { items: [] };
    if (raw.background !== undefined) {
      const bg = parseSlideColor(raw.background);
      if (!bg) return null;
      slide.background = bg;
    }
    for (const item of raw.items) {
      const parsed = parseItem(item, budget);
      if (!parsed) return null;
      slide.items.push(parsed);
    }
    slides.push(slide);
  }
  return { width, height, slides, warnings: (v.warnings as string[]).map((w) => w.slice(0, 300)) };
}
