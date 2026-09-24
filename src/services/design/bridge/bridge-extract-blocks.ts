import type { ExtractedColor, extractTextRuns, mergeTextRuns } from "./bridge-extract-text.ts";

/**
 * What one laid-out box on a slide turns into for the PowerPoint export, shipped to the frame
 * as `ppm.lib` helpers (each references nothing outside itself; collaborators are parameters).
 */

export type SlideBoxPx = { x: number; y: number; w: number; h: number; rotation: number };

/**
 * The element's rotation in degrees from its computed `transform` and `rotate`, and whether
 * that is all the transform does. A scale or skew cannot be carried over, so `pure` is false.
 */
export function cssRotation(cs: CSSStyleDeclaration): { deg: number; pure: boolean } {
  let deg = 0;
  let pure = true;
  const m = /^matrix\(([^)]+)\)$/.exec(cs.transform || "");
  if (m) {
    const [a, b, c, d] = m[1]!.split(",").map(parseFloat) as [number, number, number, number];
    deg = (Math.atan2(b, a) * 180) / Math.PI;
    if (Math.abs(Math.hypot(a, b) - 1) > 0.01 || Math.abs(Math.hypot(c, d) - 1) > 0.01 || Math.abs(a * d - b * c - 1) > 0.01) pure = false;
  } else if (cs.transform && cs.transform !== "none") pure = false;
  const r = /^(-?[\d.]+)deg$/.exec(cs.rotate || "");
  if (r) deg += parseFloat(r[1]!);
  else if (cs.rotate && cs.rotate !== "none") pure = false;
  if (cs.scale && cs.scale !== "none" && cs.scale !== "1") pure = false;
  return { deg: Math.round((((deg % 360) + 360) % 360) * 100) / 100, pure };
}

/**
 * The shape (background and uniform border) and the text box of one non-inline element, in
 * paint order. `opacity` is the element's own times its ancestors', folded into every colour.
 */
export function blockItems(
  el: Element,
  win: Window,
  box: SlideBoxPx,
  opacity: number,
  colorOf: (value: string) => ExtractedColor | null,
  note: (label: string) => void,
  text: { extractTextRuns: typeof extractTextRuns; mergeTextRuns: typeof mergeTextRuns },
): Array<Record<string, unknown>> {
  const cs = win.getComputedStyle(el);
  const items: Array<Record<string, unknown>> = [];
  const px = (v: string): number => parseFloat(v) || 0;
  const fade = (c: ExtractedColor | null): ExtractedColor | null =>
    (c && c.alpha * opacity > 0.01 ? { hex: c.hex, alpha: Math.round(c.alpha * opacity * 1000) / 1000 } : null);

  if (cs.backgroundImage && cs.backgroundImage !== "none") {
    note(cs.backgroundImage.indexOf("gradient") >= 0 ? "gradient background" : "background image");
  }
  if (cs.boxShadow && cs.boxShadow !== "none") note("box shadow");
  if (cs.filter && cs.filter !== "none") note("CSS filter");
  if (cs.mixBlendMode && cs.mixBlendMode !== "normal") note("blend mode");

  const sides = ["top", "right", "bottom", "left"].map((s) => ({
    w: px(cs.getPropertyValue("border-" + s + "-width")),
    style: cs.getPropertyValue("border-" + s + "-style"),
    color: cs.getPropertyValue("border-" + s + "-color"),
  }));
  const drawn = sides.filter((s) => s.w > 0 && s.style !== "none" && s.style !== "hidden");
  const uniform = drawn.length === 4 && drawn.every((s) => s.w === drawn[0]!.w && s.color === drawn[0]!.color);
  if (drawn.length && !uniform) note("border on some sides only");
  const fill = fade(colorOf(cs.backgroundColor));
  const borderColor = uniform ? fade(colorOf(drawn[0]!.color)) : null;
  if (fill || borderColor) {
    const shape: Record<string, unknown> = Object.assign({ kind: "shape" }, box);
    if (fill) shape.fill = fill;
    if (borderColor) shape.border = { widthPx: drawn[0]!.w, color: borderColor };
    const radius = cs.borderTopLeftRadius || "";
    const r = radius.slice(-1) === "%" ? (px(radius) * Math.min(box.w, box.h)) / 100 : px(radius);
    if (r > 0) shape.radiusPx = Math.min(r, Math.min(box.w, box.h) / 2);
    items.push(shape);
  }

  // Text of its own: a text node, or an inline element holding text, directly inside.
  let ownText = false;
  for (let c = el.firstChild; c && !ownText; c = c.nextSibling) {
    if (c.nodeType === 3) ownText = /\S/.test((c as Text).data);
    else if (c.nodeType === 1 && !/^(script|style|template|noscript|img|svg|canvas)$/i.test((c as Element).tagName)) {
      ownText = /^(inline|contents|)$/.test(win.getComputedStyle(c as Element).display) && /\S/.test(c.textContent || "");
    }
  }
  if (!ownText) return items;
  const runs = text.mergeTextRuns(text.extractTextRuns(el, win, colorOf, note));
  for (const run of runs) if (run.color) run.color = fade(run.color) || { hex: run.color.hex, alpha: 0 };
  if (!runs.length) return items;
  const inset = {
    l: px(cs.borderLeftWidth) + px(cs.paddingLeft), r: px(cs.borderRightWidth) + px(cs.paddingRight),
    t: px(cs.borderTopWidth) + px(cs.paddingTop), b: px(cs.borderBottomWidth) + px(cs.paddingBottom),
  };
  const item: Record<string, unknown> = Object.assign({ kind: "text" }, box, {
    x: box.x + inset.l, y: box.y + inset.t,
    w: Math.max(1, box.w - inset.l - inset.r), h: Math.max(1, box.h - inset.t - inset.b), runs,
  });
  // A flex or grid box that centres its text does it with alignment, not `text-align`;
  // in a column flex box the two axes swap.
  const flex = /flex|grid/.test(cs.display);
  const column = flex && /column/.test(cs.flexDirection);
  const main = flex ? cs.justifyContent : "";
  const cross = flex ? cs.alignItems : "";
  const across = column ? cross : main;
  const down = column ? main : cross;
  const ta = cs.textAlign;
  item.align = ta === "center" || across === "center" ? "center"
    : ta === "right" || (ta === "end" && cs.direction !== "rtl") || /flex-end|^end$/.test(across) ? "right"
    : ta === "justify" ? "justify" : "left";
  item.valign = down === "center" ? "middle" : /flex-end|^end$/.test(down) ? "bottom" : "top";
  if (cs.lineHeight !== "normal" && px(cs.lineHeight) > 0) item.lineHeightPx = px(cs.lineHeight);
  if (el.tagName === "LI" && cs.listStyleType !== "none") {
    item.bullet = el.parentElement && el.parentElement.tagName === "OL" ? "number" : "bullet";
  }
  items.push(item);
  return items;
}
