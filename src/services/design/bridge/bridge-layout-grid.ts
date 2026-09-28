import type { BridgeApi } from "./bridge-core.ts";
import type { CanvasCheckKind } from "../../../shared/design-canvas-check.ts";

/**
 * The canvas self-check's grid rule and the element label every rule uses. Both ship into
 * the design frame as source (`ppm.lib`), so neither may reference this module's scope.
 *
 * The bug this exists for: an item with a definite row but no column (`grid-row: 1 / -1`)
 * and another with a definite cell (`grid-column: 1 / -1; grid-row: 2`) both want column 1.
 * The definite one is placed first, so auto-placement pushes the other into an implicit
 * column past the template, and every later item shifts one column. Nothing errors; the
 * page just looks wrong.
 *
 * Detection needs the explicit grid, which the resolved `grid-template-columns` does not
 * give (for a grid container it lists every track, implicit ones included) and stylesheet
 * text cannot give from an opaque origin. So each grid gets a probe for the duration of the
 * measurement: an absolutely positioned child spanning lines `1 / -1`, whose box *is* the
 * explicit grid area, because negative lines count from the end of the explicit grid and an
 * absolutely positioned child takes no part in auto-placement. A static container is made
 * `relative` for that instant so it is the probe's containing block; everything is put back
 * before the browser can paint.
 */

export type CheckAdd = (kind: CanvasCheckKind, message: string, el?: Element) => void;

/** `tag#id.class.class [data-ppm-id=N] "text…"`, at most 200 characters. */
export function checkLabel(el: Element, withText: boolean): string {
  let s = el.localName.toLowerCase();
  const id = el.getAttribute("id");
  if (id && /^[\w-]{1,40}$/.test(id)) s += "#" + id;
  const classes = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
  for (let i = 0; i < classes.length; i++) s += "." + classes[i]!.slice(0, 30);
  if (!withText) return s.slice(0, 80);
  const ppmId = el.getAttribute("data-ppm-id");
  if (ppmId && /^\d{1,10}$/.test(ppmId)) s += " [data-ppm-id=" + ppmId + "]";
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) s += ' "' + (text.length > 40 ? text.slice(0, 40) + "…" : text) + '"';
  return s.slice(0, 200);
}

export function gridImplicitFindings(ppm: BridgeApi, add: CheckAdd): void {
  const win = ppm.win;
  const doc = ppm.doc;
  if (!doc.body) return;
  const px = (v: string): number => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const label = (el: Element): string => ppm.lib.checkLabel(el, false);

  /** Resolved track sizes in px; null for a value that is not a plain track list. */
  function sizes(value: string): number[] | null {
    if (!value || value === "none" || /subgrid|masonry|repeat\(/.test(value)) return null;
    const out: number[] = [];
    const parts = value.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      if (!/^-?[\d.]+px$/.test(parts[i]!)) return null;
      out.push(parseFloat(parts[i]!));
    }
    return out;
  }

  /** How many tracks lie before, inside and after the explicit span [start, start + span]. */
  function split(tracks: number[], gap: number, contentStart: number, start: number, span: number) {
    let before = 0, pos = contentStart;
    if (start - contentStart > 1) {
      while (before < tracks.length && pos + tracks[before]! <= start + 1) { pos += tracks[before]! + gap; before++; }
    }
    let explicit = 0, width = 0;
    if (span > 0.5) {
      for (let i = before; i < tracks.length; i++) {
        const next = width + (explicit ? gap : 0) + tracks[i]!;
        if (next > span + 1) break;
        width = next;
        explicit++;
      }
    }
    return { before, explicit, after: tracks.length - before - explicit };
  }

  function explicitArea(grid: HTMLElement, cs: CSSStyleDeclaration): DOMRect {
    const prev = grid.style.getPropertyValue("position");
    const prevPriority = grid.style.getPropertyPriority("position");
    const moved = cs.position === "static";
    if (moved) grid.style.setProperty("position", "relative", "important");
    const probe = doc.createElement("ppm-design-probe");
    const props = [["position", "absolute"], ["display", "block"], ["inset", "0"], ["margin", "0"], ["padding", "0"],
      ["border", "0"], ["grid-column", "1 / -1"], ["grid-row", "1 / -1"], ["visibility", "hidden"], ["pointer-events", "none"]];
    for (let i = 0; i < props.length; i++) probe.style.setProperty(props[i]![0]!, props[i]![1]!, "important");
    grid.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    grid.removeChild(probe);
    if (moved) {
      if (prev) grid.style.setProperty("position", prev, prevPriority);
      else grid.style.removeProperty("position");
    }
    return rect;
  }

  function items(grid: Element): Element[] {
    const out: Element[] = [];
    const kids = grid.children;
    for (let i = 0; i < kids.length; i++) {
      const s = win.getComputedStyle(kids[i]!);
      if (s.display === "contents") { out.push.apply(out, items(kids[i]!)); continue; }
      if (s.display === "none" || s.position === "absolute" || s.position === "fixed") continue;
      out.push(kids[i]!);
    }
    return out;
  }

  function placement(el: Element): string {
    const s = win.getComputedStyle(el);
    const line = (a: string, b: string): string => (b === "auto" ? a : a + " / " + b);
    const parts: string[] = [];
    if (s.gridColumnStart !== "auto" || s.gridColumnEnd !== "auto") parts.push("grid-column: " + line(s.gridColumnStart, s.gridColumnEnd));
    if (s.gridRowStart !== "auto" || s.gridRowEnd !== "auto") parts.push("grid-row: " + line(s.gridRowStart, s.gridRowEnd));
    return parts.join("; ");
  }

  const all = doc.body.getElementsByTagName("*");
  const grids: HTMLElement[] = [];
  for (let i = 0; i < all.length && i < 8000; i++) {
    const d = win.getComputedStyle(all[i]!).display;
    if (d === "grid" || d === "inline-grid") grids.push(all[i] as HTMLElement);
  }
  for (let g = 0; g < grids.length; g++) {
    const grid = grids[g]!;
    const cs = win.getComputedStyle(grid);
    const cols = sizes(cs.gridTemplateColumns), rows = sizes(cs.gridTemplateRows);
    if (!cols || !rows || !grid.getClientRects().length) continue;
    const area = explicitArea(grid, cs);
    const box = grid.getBoundingClientRect();
    const colSplit = split(cols, px(cs.columnGap), box.left + px(cs.borderLeftWidth) + px(cs.paddingLeft) - grid.scrollLeft, area.left, area.width);
    const rowSplit = split(rows, px(cs.rowGap), box.top + px(cs.borderTopWidth) + px(cs.paddingTop) - grid.scrollTop, area.top, area.height);
    const flowColumn = cs.gridAutoFlow.indexOf("column") >= 0;
    const areas = !!cs.gridTemplateAreas && cs.gridTemplateAreas !== "none";
    const axes: Array<{ name: string; prop: string; s: { before: number; explicit: number; after: number }; lo: number; hi: number; x: boolean }> = [
      { name: "column", prop: "grid-template-columns", s: colSplit, lo: area.left, hi: area.right, x: true },
      { name: "row", prop: "grid-template-rows", s: rowSplit, lo: area.top, hi: area.bottom, x: false },
    ];
    for (let a = 0; a < axes.length; a++) {
      const axis = axes[a]!;
      const implicit = axis.s.before + axis.s.after;
      // Implicit tracks along the flow direction are how a grid with no row template grows;
      // they are a mistake only when the template claims to lay out the whole grid (areas).
      const alongFlow = axis.x === flowColumn;
      if (axis.s.explicit === 0 || implicit === 0 || (alongFlow && !areas)) continue;
      const list = items(grid);
      const pushed: Element[] = [], fixed: Element[] = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i]!.getBoundingClientRect();
        const mid = axis.x ? r.left + r.width / 2 : r.top + r.height / 2;
        if (mid < axis.lo - 1 || mid > axis.hi + 1) pushed.push(list[i]!);
        else if (placement(list[i]!)) fixed.push(list[i]!);
      }
      const named = pushed.slice(0, 3).map((el) => label(el) + (placement(el) ? " (" + placement(el) + ")" : "")).join(", ");
      const plural = (n: number): string => n + " " + axis.name + (n === 1 ? "" : "s");
      let message = axis.prop + " defines " + plural(axis.s.explicit) + ", but " + plural(implicit) + " were added implicitly";
      if (pushed.length) message += " for " + named + (pushed.length > 3 ? " and " + (pushed.length - 3) + " more" : "");
      message += ".";
      if (fixed.length) message += " Placed first: " + fixed.slice(0, 2).map((el) => label(el) + " (" + placement(el) + ")").join(", ") + ".";
      const advice = " Give the pushed items an explicit grid-" + axis.name + " or fix the template.";
      if (message.length + advice.length <= 300) message += advice;
      add("implicit-grid", message.length > 300 ? message.slice(0, 299) + "…" : message, grid);
    }
  }
}
