/**
 * How the remote screen is fitted into the viewer — RustDesk's `ViewStyle`, ported.
 *
 * `adaptive` is the default there and here, and it is deliberately the one mode that computes
 * *nothing*: the canvas keeps `max-w-full max-h-full` and the browser fits it, which is the
 * behaviour the viewer has always had. Only `original` and `custom` need an explicit CSS size,
 * and neither needs to know the viewport — they are a function of the capture's own pixel size,
 * so there is no ResizeObserver anywhere in this feature.
 *
 * Input mapping needs no changes for any of this: `fractionFromPoint` reads the canvas's
 * `getBoundingClientRect()`, so a canvas sized to 40% or 300% still maps a click to the right
 * host pixel, and a scrolled container is already accounted for (the rect is viewport-relative).
 */

export type ViewStyle = "adaptive" | "original" | "custom";

/** RustDesk's default too — the only mode that always shows the whole remote screen. */
export const DEFAULT_VIEW_STYLE: ViewStyle = "adaptive";

/** Order the picker lists them in, matching RustDesk's menu. */
export const VIEW_STYLE_ORDER: readonly ViewStyle[] = ["original", "adaptive", "custom"];

export const VIEW_STYLE_LABELS: Record<ViewStyle, string> = {
  original: "Scale original",
  adaptive: "Scale adaptive",
  custom: "Scale custom",
};

/** 25%–300%. Below a quarter the picture is unusable and above 3x a 4K capture would ask the
 *  browser for a 12K-wide layer, which is where compositing starts failing outright. */
/* Bounds and slider mapping ported from RustDesk's `custom_scale_base.dart` +
 * `consts.dart` (`kScaleCustomMinPercent` … `kDebounceCustomScaleDuration`), because the
 * obvious implementation of this control is wrong in a way that is only obvious once built:
 * the range is 5%–1000%, so a *linear* slider puts 100% at 9.5% of the track — the one value
 * users actually want sits pinned against the left stop and cannot be hit. RustDesk's slider
 * is piecewise-linear around a pivot: the first third of the track covers 5%→100% and the
 * remaining two thirds cover 100%→1000%, with a detent that snaps back to exactly 100%. */
export const CUSTOM_SCALE_MIN_PERCENT = 5;
export const CUSTOM_SCALE_MAX_PERCENT = 1000;
export const CUSTOM_SCALE_PIVOT_PERCENT = 100;
/** 100% sits one third along the track. */
export const CUSTOM_SCALE_PIVOT_POS = 1 / 3;
/** Snap window around the pivot, in normalised track units (~0.6%). */
export const CUSTOM_SCALE_DETENT = 0.006;
/** The +/- buttons move one percentage point, matching RustDesk's `nudgeScale(±1)`. */
export const CUSTOM_SCALE_NUDGE_PERCENT = 1;
/** Committing on every slider tick would respawn nothing (this is pure CSS) but would write the
 *  device pref hundreds of times per drag. RustDesk debounces by the same 300ms. */
export const CUSTOM_SCALE_DEBOUNCE_MS = 300;

export const CUSTOM_SCALE_MIN = CUSTOM_SCALE_MIN_PERCENT / 100;
export const CUSTOM_SCALE_MAX = CUSTOM_SCALE_MAX_PERCENT / 100;
export const DEFAULT_CUSTOM_SCALE = 1;

/** Normalised track position [0,1] → percent. Piecewise around the pivot; see the note above. */
export function scalePosToPercent(pos: number): number {
  if (!Number.isFinite(pos) || pos <= 0) return CUSTOM_SCALE_MIN_PERCENT;
  if (pos >= 1) return CUSTOM_SCALE_MAX_PERCENT;
  if (pos <= CUSTOM_SCALE_PIVOT_POS) {
    const q = pos / CUSTOM_SCALE_PIVOT_POS;
    return clampScalePercent(Math.round(
      CUSTOM_SCALE_MIN_PERCENT + q * (CUSTOM_SCALE_PIVOT_PERCENT - CUSTOM_SCALE_MIN_PERCENT),
    ));
  }
  const q = (pos - CUSTOM_SCALE_PIVOT_POS) / (1 - CUSTOM_SCALE_PIVOT_POS);
  return clampScalePercent(Math.round(
    CUSTOM_SCALE_PIVOT_PERCENT + q * (CUSTOM_SCALE_MAX_PERCENT - CUSTOM_SCALE_PIVOT_PERCENT),
  ));
}

/** Percent → normalised track position. Inverse of `scalePosToPercent`. */
export function scalePercentToPos(percent: number): number {
  const p = clampScalePercent(percent);
  if (p <= CUSTOM_SCALE_PIVOT_PERCENT) {
    const q = (p - CUSTOM_SCALE_MIN_PERCENT) / (CUSTOM_SCALE_PIVOT_PERCENT - CUSTOM_SCALE_MIN_PERCENT);
    return q * CUSTOM_SCALE_PIVOT_POS;
  }
  const q = (p - CUSTOM_SCALE_PIVOT_PERCENT) / (CUSTOM_SCALE_MAX_PERCENT - CUSTOM_SCALE_PIVOT_PERCENT);
  return CUSTOM_SCALE_PIVOT_POS + q * (1 - CUSTOM_SCALE_PIVOT_POS);
}

/** Snap a dragged position onto the pivot when it lands close, so 100% is reachable exactly. */
export function snapScalePos(pos: number): number {
  if (!Number.isFinite(pos)) return CUSTOM_SCALE_PIVOT_POS;
  if (Math.abs(pos - CUSTOM_SCALE_PIVOT_POS) <= CUSTOM_SCALE_DETENT) return CUSTOM_SCALE_PIVOT_POS;
  return Math.min(Math.max(pos, 0), 1);
}

export function clampScalePercent(percent: number): number {
  if (!Number.isFinite(percent)) return CUSTOM_SCALE_PIVOT_PERCENT;
  return Math.min(Math.max(Math.round(percent), CUSTOM_SCALE_MIN_PERCENT), CUSTOM_SCALE_MAX_PERCENT);
}

/** Coerce a stored or wire value into a real mode. Same `Object.hasOwn` reasoning as
 *  `parsePresetId`: a prototype-walking check would let `"toString"` through. */
export function parseViewStyle(value: unknown): ViewStyle {
  return typeof value === "string" && Object.hasOwn(VIEW_STYLE_LABELS, value)
    ? value as ViewStyle
    : DEFAULT_VIEW_STYLE;
}

/** Clamp to the supported range, falling back to 1 for anything that is not a real number.
 *
 *  Strict about the type rather than coercing: `Number(null)` is **0**, which is finite, so a
 *  coercing check would quietly turn a missing value into the 25% floor — a remote screen at
 *  quarter size looks like a rendering bug, not a default. And `width: NaNpx` is dropped
 *  silently, so a NaN that got this far would collapse the canvas to nothing with no error. */
export function clampCustomScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CUSTOM_SCALE;
  return Math.min(Math.max(value, CUSTOM_SCALE_MIN), CUSTOM_SCALE_MAX);
}

/** One step up or down for a +/- button: one percentage point, as RustDesk's `nudgeScale`. */
export function stepCustomScale(current: number, direction: 1 | -1): number {
  const next = clampScalePercent(Math.round(clampCustomScale(current) * 100) + direction * CUSTOM_SCALE_NUDGE_PERCENT);
  return next / 100;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * CSS pixel size to give the canvas, or **null** to leave it to the stylesheet (adaptive).
 *
 * `natural` is the capture's own size (`canvas.width`/`canvas.height`, which the decoder sets
 * from the decoded frame) — not the element's rendered box, which is what this decides.
 * Returns null for a capture that has no size yet, so the first paint before any frame has
 * arrived does not pin the canvas to 0x0.
 */
export function canvasCssSize(style: ViewStyle, customScale: number, natural: Size): Size | null {
  if (style === "adaptive") return null;
  if (natural.width <= 0 || natural.height <= 0) return null;
  const scale = style === "original" ? 1 : clampCustomScale(customScale);
  return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
}

/** What to show on a compact control. Adaptive has no meaningful percentage (it is whatever
 *  fits), so it is named rather than measured. */
export function viewStyleShortLabel(style: ViewStyle, customScale: number): string {
  if (style === "adaptive") return "Fit";
  if (style === "original") return "1:1";
  return `${Math.round(clampCustomScale(customScale) * 100)}%`;
}
