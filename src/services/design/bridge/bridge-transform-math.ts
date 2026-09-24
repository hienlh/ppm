/**
 * The arithmetic behind the canvas's move and resize handles.
 *
 * Each function is shipped to the frame as its own source through `ppm.lib` (see
 * bridge-script.ts), so each one must be self-contained: no reference to anything else in
 * this module, not even to another function in it.
 *
 * Moving writes the individual `translate` property: it composes with an existing
 * `transform`, never reflows siblings, and works whether or not the element is positioned.
 * Resizing writes `width`/`height`; a drag from the left or top edge also shifts `translate`
 * by what the size gave up, so the opposite edge stays where it was.
 */

export type TransformZone = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface TransformBoxValue {
  tx: number;
  ty: number;
  w: number;
  h: number;
}

export interface ZoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A `translate` value as px offsets, or null when it holds anything else (a percentage, a
 * `calc()`, a non-zero z) — a value the handles cannot extend without changing its meaning.
 * `none` and the empty string are no offset at all.
 */
export function parseTranslate(value: string | null | undefined): { x: number; y: number } | null {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  if (v === "" || v === "none") return { x: 0, y: 0 };
  const parts = v.split(/\s+/);
  if (parts.length > 3) return null;
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)(px)?$/.exec(parts[i]!);
    if (!m) return null;
    const n = Number(m[1]);
    // A unitless number is only valid CSS for zero.
    if (!Number.isFinite(n) || (!m[2] && n !== 0)) return null;
    nums.push(n);
  }
  if (nums.length === 3 && nums[2] !== 0) return null;
  return { x: nums[0]!, y: nums.length > 1 ? nums[1]! : 0 };
}

/** `n` as a CSS px value: at most two decimals, within ±20000, never `-0`. */
export function formatPx(n: number): string {
  const clamped = Math.max(-20000, Math.min(20000, Number.isFinite(n) ? n : 0));
  const rounded = Math.round(clamped * 100) / 100;
  return (rounded === 0 ? 0 : rounded) + "px";
}

/**
 * The box after dragging `zone` by (dx, dy) frame px from `start`. Sizes never go below
 * `min`; when a left or top drag hits that floor, the offset stops with it.
 */
export function applyDrag(start: TransformBoxValue, zone: TransformZone, dx: number, dy: number, min?: number): TransformBoxValue {
  const floor = typeof min === "number" && min > 0 ? min : 1;
  const out = { tx: start.tx, ty: start.ty, w: start.w, h: start.h };
  if (zone === "move") {
    out.tx = start.tx + dx;
    out.ty = start.ty + dy;
    return out;
  }
  if (zone.indexOf("e") >= 0) out.w = Math.max(floor, start.w + dx);
  if (zone.indexOf("w") >= 0) {
    out.w = Math.max(floor, start.w - dx);
    out.tx = start.tx + (start.w - out.w);
  }
  if (zone.indexOf("s") >= 0) out.h = Math.max(floor, start.h + dy);
  if (zone.indexOf("n") >= 0) {
    out.h = Math.max(floor, start.h - dy);
    out.ty = start.ty + (start.h - out.h);
  }
  return out;
}

/**
 * Which handle a point is on: a square of side `hit` around each handle, and the element
 * itself for moving. The middle half of the element always moves, so an element smaller
 * than its handles can still be dragged by its centre.
 */
export function zoneAt(rect: ZoneRect, px: number, py: number, hit: number): TransformZone | null {
  const half = hit / 2;
  const inside = px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  if (inside && Math.abs(px - cx) <= rect.w / 4 && Math.abs(py - cy) <= rect.h / 4) return "move";
  const x = rect.x, y = rect.y, r = rect.x + rect.w, b = rect.y + rect.h;
  const points: Array<[TransformZone, number, number]> = [
    ["nw", x, y], ["ne", r, y], ["sw", x, b], ["se", r, b], ["n", cx, y], ["s", cx, b], ["w", x, cy], ["e", r, cy],
  ];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (Math.abs(px - p[1]) <= half && Math.abs(py - p[2]) <= half) return p[0];
  }
  return inside ? "move" : null;
}
