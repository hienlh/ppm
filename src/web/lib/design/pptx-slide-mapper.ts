import type { SlideColor, SlideDoc, SlideItem, SlideTextItem } from "../../../shared/design-slide-doc";

/**
 * A measured deck ({@link SlideDoc}, CSS px) as the calls the PowerPoint writer makes, in
 * inches and points. Pure, so the unit maths is tested without pptxgenjs in the process; the
 * lazy `pptx-export` module only replays the plan.
 *
 * `px → in` is `/96` and `px → pt` is `* 0.75`, so a 1280x720 deck is exactly
 * `LAYOUT_WIDE` (13.333 x 7.5 in). Text boxes are placed on the element's content box with
 * no inner margin, so text starts where the browser drew it. Fonts are referenced by name;
 * PowerPoint substitutes a face it does not have, which the warnings say.
 */

export type PptxColor = { color: string; transparency?: number };

export interface PptxRunOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: { style: "sng" };
  color?: string;
  transparency?: number;
  fontSize?: number;
  fontFace?: string;
  breakLine?: boolean;
  bullet?: boolean | { type: "number" };
}

export interface PptxBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
}

export type PptxOp =
  | { kind: "text"; runs: Array<{ text: string; options: PptxRunOptions }>; options: PptxBox & {
      align: "left" | "center" | "right" | "justify"; valign: "top" | "middle" | "bottom";
      margin: number; lineSpacing?: number; fit: "none"; wrap: true; isTextBox: true;
    } }
  | { kind: "shape"; shape: "rect" | "roundRect"; options: PptxBox & {
      fill?: PptxColor; line?: PptxColor & { width: number }; rectRadius?: number;
    } }
  | { kind: "image"; options: PptxBox & { data: string } };

export interface PptxPlan {
  layout: "LAYOUT_WIDE" | { name: string; width: number; height: number };
  slides: Array<{ background?: PptxColor; ops: PptxOp[] }>;
  warnings: string[];
}

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;
export const pxToIn = (px: number): number => round(px / 96, 4);
export const pxToPt = (px: number): number => round(px * 0.75, 2);

/** Hex plus pptxgenjs's `transparency` (0-100), omitted when opaque. */
export function pptxColor(c: SlideColor): PptxColor {
  const transparency = Math.round((1 - c.alpha) * 100);
  return transparency > 0 ? { color: c.hex, transparency } : { color: c.hex };
}

function box(item: SlideItem): PptxBox {
  const b: PptxBox = { x: pxToIn(item.x), y: pxToIn(item.y), w: pxToIn(item.w), h: pxToIn(item.h) };
  if (item.rotation) b.rotate = round(item.rotation, 2);
  return b;
}

function textOp(item: SlideTextItem): PptxOp {
  let paragraphStart = true;
  const runs = item.runs.map((run) => {
    const options: PptxRunOptions = {};
    if (run.bold) options.bold = true;
    if (run.italic) options.italic = true;
    if (run.underline) options.underline = { style: "sng" };
    if (run.color) Object.assign(options, pptxColor(run.color));
    if (run.sizePx) options.fontSize = Math.max(1, Math.min(4000, pxToPt(run.sizePx)));
    if (run.font) options.fontFace = run.font;
    if (run.breakLine) options.breakLine = true;
    // A bullet belongs to a paragraph, which in the run list starts after each break.
    if (item.bullet && paragraphStart) options.bullet = item.bullet === "number" ? { type: "number" } : true;
    paragraphStart = !!run.breakLine;
    return { text: run.text, options };
  });
  const options: Extract<PptxOp, { kind: "text" }>["options"] = {
    ...box(item), align: item.align, valign: item.valign, margin: 0, fit: "none", wrap: true, isTextBox: true,
  };
  if (item.lineHeightPx) options.lineSpacing = pxToPt(item.lineHeightPx);
  return { kind: "text", runs, options };
}

function itemOp(item: SlideItem): PptxOp {
  if (item.kind === "text") return textOp(item);
  if (item.kind === "image") return { kind: "image", options: { ...box(item), data: item.data } };
  const options: Extract<PptxOp, { kind: "shape" }>["options"] = { ...box(item) };
  if (item.fill) options.fill = pptxColor(item.fill);
  if (item.border) options.line = { ...pptxColor(item.border.color), width: pxToPt(item.border.widthPx) };
  // pptxgenjs 4 takes the corner radius in inches and writes it as OOXML's fraction of the
  // shorter side, which PowerPoint caps at one half — hence the clamp.
  if (item.radiusPx) options.rectRadius = pxToIn(Math.min(item.radiusPx, item.w / 2, item.h / 2));
  return { kind: "shape", shape: item.radiusPx ? "roundRect" : "rect", options };
}

export function mapSlideDocToPptx(doc: SlideDoc): PptxPlan {
  const layout: PptxPlan["layout"] = doc.width === 1280 && doc.height === 720
    ? "LAYOUT_WIDE"
    : { name: "PPM_DESIGN", width: pxToIn(doc.width), height: pxToIn(doc.height) };
  const fonts = new Set<string>();
  const slides = doc.slides.map((slide) => {
    for (const item of slide.items) if (item.kind === "text") for (const run of item.runs) if (run.font) fonts.add(run.font);
    return { ...(slide.background ? { background: pptxColor(slide.background) } : {}), ops: slide.items.map(itemOp) };
  });
  const warnings = [...doc.warnings];
  if (fonts.size) {
    const list = [...fonts].slice(0, 8).join(", ");
    warnings.push(`Fonts are referenced by name (${list}${fonts.size > 8 ? ", …" : ""}); PowerPoint substitutes any it does not have.`);
  }
  return { layout, slides, warnings };
}
