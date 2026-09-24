import type { TransformBoxValue } from "./bridge-transform-math.ts";

/**
 * Reading and writing the three inline properties the canvas handles change, on the live
 * element inside the design frame.
 *
 * The box is what the element has *now*: the computed `translate` (so a stylesheet's offset
 * is extended, not replaced by zero) and the computed `width`/`height`, falling back to the
 * rendered size where those are not px (`auto` on an inline element). `apply` always starts
 * from the inline values saved when the gesture began and sets only what changed, so an
 * untouched `width: auto` stays auto and a revert is exact.
 *
 * Shipped as source (`ppm.lib.createTransformStyle`); the two helpers it needs are handed
 * in, since it may not reference anything in this module.
 */

export type SavedInlineStyle = Record<string, [string, string]>;

export interface TransformPending {
  start: TransformBoxValue;
  box: TransformBoxValue;
  base: SavedInlineStyle;
}

export interface TransformStyle {
  /** `movable` is false when the element's `translate` is not a plain px offset. */
  measure(el: HTMLElement): { box: TransformBoxValue; movable: boolean };
  save(el: HTMLElement): SavedInlineStyle;
  restore(el: HTMLElement, saved: SavedInlineStyle): void;
  /** The props a gesture from `start` to `box` would write. */
  props(start: TransformBoxValue, box: TransformBoxValue): Record<string, string>;
  apply(el: HTMLElement, pending: TransformPending): void;
}

export function createTransformStyle(
  win: Window,
  formatPx: (n: number) => string,
  parseTranslate: (value: string | null | undefined) => { x: number; y: number } | null,
): TransformStyle {
  const PROPS = ["translate", "width", "height"];
  const px = (v: string, fallback: number): number => (/px$/.test(v) && isFinite(parseFloat(v)) ? parseFloat(v) : fallback);

  function save(el: HTMLElement): SavedInlineStyle {
    const out: SavedInlineStyle = {};
    for (const p of PROPS) out[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
    return out;
  }
  function restore(el: HTMLElement, saved: SavedInlineStyle): void {
    for (const p of PROPS) {
      const entry = saved[p];
      if (entry && entry[0]) el.style.setProperty(p, entry[0], entry[1]);
      else el.style.removeProperty(p);
    }
  }
  function props(start: TransformBoxValue, box: TransformBoxValue): Record<string, string> {
    const out: Record<string, string> = {};
    if (box.tx !== start.tx || box.ty !== start.ty) out.translate = formatPx(box.tx) + " " + formatPx(box.ty);
    if (box.w !== start.w) out.width = formatPx(box.w);
    if (box.h !== start.h) out.height = formatPx(box.h);
    return out;
  }
  return {
    measure(el) {
      const cs = win.getComputedStyle(el);
      const t = parseTranslate(cs.getPropertyValue("translate") || el.style.getPropertyValue("translate"));
      const r = el.getBoundingClientRect();
      return { box: { tx: t ? t.x : 0, ty: t ? t.y : 0, w: px(cs.width, r.width), h: px(cs.height, r.height) }, movable: t !== null };
    },
    save,
    restore,
    props,
    apply(el, pending) {
      restore(el, pending.base);
      const next = props(pending.start, pending.box);
      for (const name of Object.keys(next)) el.style.setProperty(name, next[name]!);
    },
  };
}
