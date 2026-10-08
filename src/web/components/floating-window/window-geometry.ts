/**
 * Pure geometry for the floating window layer — no DOM, no React, so every rule
 * (min size, on-screen clamping, per-handle resize, spawn cascade) is unit-testable.
 *
 * All coordinates are relative to the layer container (the app content area), not the
 * browser viewport: the nav rail must stay usable while a window is maximised.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Size of the layer container the rects live in. */
export interface Bounds {
  w: number;
  h: number;
}

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_HANDLES: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export const MIN_SIZE = { w: 360, h: 240 } as const;

/**
 * How much of the titlebar must remain reachable after a clamp. A window dragged past an
 * edge keeps this many pixels inside the layer so it can always be grabbed back.
 */
export const KEEP_VISIBLE = 48;

/** Offset between consecutive spawns, matching desktop window managers. */
export const CASCADE_STEP = 24;

/**
 * Hard cap on simultaneous windows so the z-band stays inside 30..38. Minimized windows
 * count too: they come back without asking for a slot.
 */
export const MAX_WINDOWS = 8;

/** Base z-index of the layer; strictly below the app's z-40 backdrops and z-50 popovers. */
export const Z_BASE = 30;

const PREFERRED = { w: 880, h: 560 } as const;
const SPAWN_MARGIN = 48;
/** Cap on a portrait window's height — a 9:16 window this tall already shows a full step
 *  list; taller than that just wastes space on an ultrawide monitor. */
const PORTRAIT_MAX_H = 780;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Inline z-index for a window at `rank` (0 = backmost). Never exceeds Z_BASE + 8. */
export function windowZIndex(rank: number): number {
  return Z_BASE + clamp(Math.trunc(rank), 0, MAX_WINDOWS);
}

/**
 * Fit a rect inside the layer: at least MIN_SIZE, never wider/taller than the layer, and
 * positioned so KEEP_VISIBLE px of the titlebar row stay inside. Values are rounded to
 * whole pixels — sub-pixel transforms blur text on high-DPI screens.
 */
export function clampRect(rect: Rect, bounds: Bounds): Rect {
  const w = Math.max(MIN_SIZE.w, Math.min(rect.w, Math.max(bounds.w, MIN_SIZE.w)));
  const h = Math.max(MIN_SIZE.h, Math.min(rect.h, Math.max(bounds.h, MIN_SIZE.h)));
  // Left edge may go negative (window hangs off the left) as long as its right edge
  // still shows KEEP_VISIBLE px; the top edge may never go above the layer, or the
  // titlebar becomes unreachable.
  const x = clamp(rect.x, KEEP_VISIBLE - w, Math.max(KEEP_VISIBLE - w, bounds.w - KEEP_VISIBLE));
  const y = clamp(rect.y, 0, Math.max(0, bounds.h - KEEP_VISIBLE));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Apply a drag delta to one of the 8 handles.
 *
 * Edges anchored by the handle stay put; the opposite edge moves. Shrinking past the
 * minimum stops the moving edge instead of pushing the anchored one, which is what makes
 * a resize feel like a native window instead of sliding away under the cursor.
 */
export function applyResize(
  rect: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min: { w: number; h: number } = MIN_SIZE,
): Rect {
  let { x, y, w, h } = rect;

  if (handle.includes("e")) {
    w = Math.max(min.w, rect.w + dx);
  } else if (handle.includes("w")) {
    const right = rect.x + rect.w;
    w = Math.max(min.w, rect.w - dx);
    x = right - w;
  }

  if (handle.includes("s")) {
    h = Math.max(min.h, rect.h + dy);
  } else if (handle.includes("n")) {
    const bottom = rect.y + rect.h;
    h = Math.max(min.h, rect.h - dy);
    y = bottom - h;
  }

  return { x, y, w, h };
}

/**
 * Where a newly opened window goes: cascaded from the top-left by CASCADE_STEP per existing
 * window, wrapping before it would walk off the layer.
 */
export function cascadeSpawnRect(existing: Rect[], bounds: Bounds, preferred: { w: number; h: number } = PREFERRED): Rect {
  const w = Math.min(preferred.w, Math.max(MIN_SIZE.w, bounds.w - SPAWN_MARGIN * 2));
  const h = Math.min(preferred.h, Math.max(MIN_SIZE.h, bounds.h - SPAWN_MARGIN * 2));
  const step = existing.length % MAX_WINDOWS;
  return clampRect(
    { x: SPAWN_MARGIN + step * CASCADE_STEP, y: SPAWN_MARGIN + step * CASCADE_STEP, w, h },
    bounds,
  );
}

/**
 * Where an agent/teammate session window spawns: a portrait 9:16 rect pinned to the
 * top-right, tall enough to read a step list without scrolling every other line, cascading
 * like any other spawn once more than one is open.
 */
export function portraitSpawnRect(existing: Rect[], bounds: Bounds): Rect {
  const h = Math.min(bounds.h - SPAWN_MARGIN * 2, PORTRAIT_MAX_H);
  const w = Math.max(MIN_SIZE.w, Math.round((h * 9) / 16));
  const step = existing.length % MAX_WINDOWS;
  return clampRect(
    { x: bounds.w - SPAWN_MARGIN - w - step * CASCADE_STEP, y: SPAWN_MARGIN + step * CASCADE_STEP, w, h },
    bounds,
  );
}

/** Share of the layer a snapped window takes, measured from the right edge. */
export const SNAP_FRACTION = 0.55;

/**
 * How far a window's right edge has to be dragged past the layer's right edge before
 * releasing it snaps the window. Measured on the window, not the pointer, so grabbing the
 * titlebar near its left end does not make the snap unreachable.
 */
export const SNAP_TRIGGER = 40;

/** The rect of a window snapped to the right: full height, `SNAP_FRACTION` of the width. */
export function snapRect(bounds: Bounds): Rect {
  const w = Math.min(bounds.w, Math.max(MIN_SIZE.w, Math.round(bounds.w * SNAP_FRACTION)));
  return { x: bounds.w - w, y: 0, w, h: bounds.h };
}

/**
 * True when a drag that started at `start` has carried the window (`rect`, before clamping)
 * far enough right to snap on release.
 *
 * Measured from wherever the right edge already was when it lies past the layer's: a window
 * may rest hanging off the right side, and grabbing one there to pull it back in must move
 * it, not snap it.
 */
export function wantsSnap(rect: Rect, start: Rect, bounds: Bounds): boolean {
  return rect.x + rect.w > Math.max(start.x + start.w, bounds.w) + SNAP_TRIGGER;
}

/** Where a window in `state` is drawn; `rect` is the restore rect it keeps meanwhile. */
export function displayedRect(state: string, rect: Rect, bounds: Bounds): Rect {
  if (state === "maximized") return { x: 0, y: 0, w: bounds.w, h: bounds.h };
  if (state === "snapped") return snapRect(bounds);
  return rect;
}

/** Nudge step for arrow keys on a focused titlebar (Shift = fine-grained). */
export function nudgeRect(rect: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
}
