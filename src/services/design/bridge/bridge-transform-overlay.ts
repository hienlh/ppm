import type { TransformZone, ZoneRect } from "./bridge-transform-math.ts";

/**
 * The move and resize handles, drawn inside the design frame.
 *
 * Like the picker's outline, they live in a closed shadow root on a host appended to
 * `<html>`, out of reach of page CSS and never part of described markup. Unlike the
 * outline, the handles are hit targets: each is a square of the given `hit` size (44 screen
 * px, converted to frame px by the parent's scale) with `touch-action: none`, so a finger on
 * one drags the element instead of scrolling the page, and the element's own box is the
 * move area. The host itself stays `pointer-events: none`, so everything outside the
 * handles still reaches the page. Seen from the window, every event on a handle targets the
 * host; `bridge-transform.ts` works out which handle from the coordinates.
 *
 * Shipped as source (`ppm.lib.createTransformOverlay`), so it may only use what it is handed.
 */

export interface TransformOverlay {
  host: HTMLElement;
  /** Place the outline and handles over `rect` (frame viewport px), or hide them. */
  place(rect: ZoneRect | null, hit: number, scale: number, zones: readonly TransformZone[]): void;
}

export function createTransformOverlay(doc: Document): TransformOverlay {
  const host = doc.createElement("ppm-design-handles");
  host.setAttribute("aria-hidden", "true");
  const props: Array<[string, string]> = [
    ["position", "fixed"], ["top", "0"], ["left", "0"], ["width", "0"], ["height", "0"], ["display", "block"],
    ["overflow", "visible"], ["pointer-events", "none"], ["z-index", "2147483647"], ["margin", "0"], ["padding", "0"],
  ];
  for (const [name, value] of props) host.style.setProperty(name, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const make = (css: string): HTMLElement => {
    const el = doc.createElement("div");
    el.style.cssText = "position:fixed;display:none;box-sizing:border-box;" + css;
    root.appendChild(el);
    return el;
  };
  const outline = make("pointer-events:none;border:1.5px solid #2563eb;");
  const move = make("pointer-events:auto;touch-action:none;cursor:move;background:transparent;");
  const cursors: Record<string, string> = {
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", w: "ew-resize", e: "ew-resize",
  };
  const order: TransformZone[] = ["nw", "ne", "sw", "se", "n", "s", "w", "e"];
  const handles: Record<string, { area: HTMLElement; dot: HTMLElement }> = {};
  for (const zone of order) {
    const area = make("pointer-events:auto;touch-action:none;cursor:" + cursors[zone] + ";");
    const dot = doc.createElement("div");
    dot.style.cssText = "position:absolute;left:50%;top:50%;box-sizing:border-box;background:#fff;border:1.5px solid #2563eb;border-radius:2px;transform:translate(-50%,-50%);";
    area.appendChild(dot);
    handles[zone] = { area, dot };
  }

  const box = (el: HTMLElement, x: number, y: number, w: number, h: number): void => {
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = Math.max(0, w) + "px";
    el.style.height = Math.max(0, h) + "px";
    el.style.display = "block";
  };

  return {
    host,
    place(rect, hit, scale, zones) {
      if (!host.isConnected && doc.documentElement) doc.documentElement.appendChild(host);
      const all = [outline, move].concat(order.map((z) => handles[z]!.area));
      if (!rect) {
        for (const el of all) el.style.display = "none";
        return;
      }
      const s = scale > 0 ? scale : 1;
      box(outline, rect.x, rect.y, rect.w, rect.h);
      outline.style.borderWidth = 1.5 / s + "px";
      if (zones.indexOf("move") >= 0) box(move, rect.x, rect.y, rect.w, rect.h);
      else move.style.display = "none";
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, r = rect.x + rect.w, b = rect.y + rect.h;
      const at: Record<string, [number, number]> = {
        nw: [rect.x, rect.y], ne: [r, rect.y], sw: [rect.x, b], se: [r, b], n: [cx, rect.y], s: [cx, b], w: [rect.x, cy], e: [r, cy],
      };
      const dot = 10 / s;
      for (const zone of order) {
        const h = handles[zone]!;
        if (zones.indexOf(zone) < 0) {
          h.area.style.display = "none";
          continue;
        }
        box(h.area, at[zone]![0] - hit / 2, at[zone]![1] - hit / 2, hit, hit);
        h.dot.style.width = dot + "px";
        h.dot.style.height = dot + "px";
        h.dot.style.borderWidth = 1.5 / s + "px";
      }
    },
  };
}
