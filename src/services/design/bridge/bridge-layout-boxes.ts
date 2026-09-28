import type { BridgeApi } from "./bridge-core.ts";
import type { CheckAdd } from "./bridge-layout-grid.ts";

/**
 * The canvas self-check's box rules, run over the rendered design: sideways page overflow,
 * elements running past the viewport, text cut off by a clipping ancestor, content squeezed
 * to nothing, and sibling blocks drawn over each other. Shipped into the frame as source
 * (`ppm.lib`), so nothing here may reference this module's scope.
 *
 * Each rule reports the outermost offender only: a card that runs off the screen takes its
 * contents with it, and listing all of them would bury the one line worth fixing. What a
 * design does on purpose is left alone: anything inside a scroll container (reachable),
 * fully off-screen drawers, visually-hidden text, transparent inputs, and grid children,
 * which only overlap when their author placed them on the same cell.
 */
export function boxFindings(ppm: BridgeApi, add: CheckAdd): void {
  const win = ppm.win;
  const doc = ppm.doc;
  const de = doc.documentElement;
  const body = doc.body;
  if (!de || !body) return;
  const SKIP = /^(script|style|template|noscript|br|wbr|option|optgroup|datalist|source|track|param|area|map|ppm-design-overlay|ppm-design-handles|ppm-design-probe)$/i;
  const REPLACED = /^(img|svg|video|canvas|iframe|input|select|textarea|button|progress|meter|embed|object)$/i;
  const vw = de.clientWidth || win.innerWidth;
  const label = (el: Element): string => ppm.lib.checkLabel(el, false);
  const round = (n: number): number => Math.round(n);
  const inside = (list: Element[], el: Element): boolean => list.some((p) => p !== el && p.contains(el));

  const sheetWide = de.scrollWidth;
  if (sheetWide > vw + 1) {
    const hidden = win.getComputedStyle(body).overflowX !== "visible" || win.getComputedStyle(de).overflowX !== "visible";
    add("page-overflow", "The page is " + sheetWide + "px wide in a " + vw + "px viewport, so " + (hidden
      ? "its right side is cut off (overflow is hidden)." : "it scrolls sideways.") + " Something below is wider than the screen.");
  }

  function ownText(el: Element): boolean {
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.nodeValue || "")) return true;
    return false;
  }
  function scrollsX(el: Element): boolean {
    for (let p = el.parentElement; p && p !== body && p !== de; p = p.parentElement) {
      const o = win.getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  }
  function clipper(el: Element): { el: Element; x: boolean; y: boolean } | null {
    for (let p = el.parentElement; p && p !== body && p !== de; p = p.parentElement) {
      const s = win.getComputedStyle(p);
      const x = s.overflowX === "hidden" || s.overflowX === "clip";
      const y = s.overflowY === "hidden" || s.overflowY === "clip";
      if (s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowY === "auto" || s.overflowY === "scroll") return null;
      if (x || y) return s.textOverflow === "ellipsis" ? null : { el: p, x, y };
    }
    return null;
  }
  function visuallyHidden(s: CSSStyleDeclaration, r: DOMRect): boolean {
    return (s.position === "absolute" || s.position === "fixed") && (r.width <= 1 || r.height <= 1)
      && (s.overflow !== "visible" || (s.clip !== "auto" && !!s.clip) || s.clipPath !== "none");
  }

  const collapsed: Element[] = [], offscreen: Element[] = [], clipped: Element[] = [];
  const parents: Element[] = [];
  const all = body.getElementsByTagName("*");
  for (let i = 0; i < all.length && i < 8000; i++) {
    const el = all[i]!;
    if (SKIP.test(el.localName) || (el as SVGElement).ownerSVGElement) continue;
    const s = win.getComputedStyle(el);
    if (s.display === "none" || s.display === "contents" || s.visibility !== "visible" || !el.getClientRects().length) continue;
    if (el.children.length >= 2 && el.children.length <= 60 && s.display !== "grid" && s.display !== "inline-grid") parents.push(el);
    const r = el.getBoundingClientRect();
    const text = ownText(el);
    const content = text || REPLACED.test(el.localName);
    if (content && (r.width < 4 || r.height < 4) && parseFloat(s.opacity) > 0 && !visuallyHidden(s, r) && !inside(collapsed, el)) {
      collapsed.push(el);
      add("collapsed", "Rendered " + round(r.width) + "x" + round(r.height) + "px although it has " + (text ? "text" : "content")
        + ", so it is invisible. Something squeezes it: a width/height, flex-shrink, min-width or an empty track.", el);
      continue;
    }
    const pastRight = r.left < vw - 1 && r.right > vw + 1;
    const pastLeft = r.left < -1 && r.right > 1;
    if ((pastRight || pastLeft) && r.width > 4 && !inside(offscreen, el) && !scrollsX(el)) {
      offscreen.push(el);
      add("offscreen", pastRight
        ? "Runs " + round(r.right - vw) + "px past the right edge of the " + vw + "px viewport (x " + round(r.left) + " to " + round(r.right) + ")."
        : "Starts " + round(-r.left) + "px left of the viewport, so its left part is not visible.", el);
      continue;
    }
    if (text && r.width >= 4 && r.height >= 4 && !inside(clipped, el)) {
      const c = clipper(el);
      if (c) {
        const b = c.el.getBoundingClientRect();
        const hitsX = r.right > b.left && r.left < b.right, hitsY = r.bottom > b.top && r.top < b.bottom;
        const outX = c.x ? Math.max(b.left - r.left, r.right - b.right, 0) : 0;
        const outY = c.y ? Math.max(b.top - r.top, r.bottom - b.bottom, 0) : 0;
        if (hitsX && hitsY && (outX > 2 || outY > 2)) {
          clipped.push(el);
          add("clipped", "Its text is cut off by " + label(c.el) + " (overflow hidden): " + round(Math.max(outX, outY))
            + "px of it is outside that box. Let the box grow, or make the content fit.", el);
        }
      }
    }
  }

  function flowBlock(el: Element): DOMRect | null {
    const s = win.getComputedStyle(el);
    const inline = /^inline/.test(s.display) && s.display !== "inline-block" && s.display !== "inline-flex";
    if (s.display === "none" || s.display === "contents" || inline) return null;
    if (s.float !== "none" || s.transform !== "none") return null;
    if (s.position !== "static" && s.position !== "relative") return null;
    if (s.position === "relative" && [s.top, s.left, s.right, s.bottom].some((v) => v !== "auto" && parseFloat(v) !== 0)) return null;
    const r = el.getBoundingClientRect();
    return r.width * r.height >= 16 ? r : null;
  }
  for (let p = 0; p < parents.length; p++) {
    const kids = parents[p]!.children;
    const boxes: Array<{ el: Element; r: DOMRect }> = [];
    for (let i = 0; i < kids.length; i++) {
      if (SKIP.test(kids[i]!.localName)) continue;
      const r = flowBlock(kids[i]!);
      if (r) boxes.push({ el: kids[i]!, r });
    }
    for (let i = 1; i < boxes.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = boxes[j]!.r, b = boxes[i]!.r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w <= 0 || h <= 0) continue;
        const share = (w * h) / Math.min(a.width * a.height, b.width * b.height);
        if (share <= 0.25) continue;
        add("overlap", "Overlaps its sibling " + label(boxes[j]!.el) + " by " + round(share * 100)
          + "% of the smaller box, although neither is positioned: usually a negative margin or a fixed size that is too small.", boxes[i]!.el);
        break;
      }
    }
  }
}
