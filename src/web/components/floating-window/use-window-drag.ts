/** Titlebar drag: moves a window, committing to the store only when the gesture ends. */

import { useDrag } from "@use-gesture/react";
import { clampRect, type Rect } from "./window-geometry";
import {
  scaledMovement,
  WINDOW_DRAG_CONFIG,
  type WindowGestureContext,
} from "./use-window-gesture-context";

export function useWindowDrag(ctx: WindowGestureContext) {
  return useDrag(
    ({ movement, first, last, memo }) => {
      // The rect is captured once per gesture: `movement` is cumulative from the start,
      // so re-reading a rect that we ourselves are mutating would compound the delta.
      const base: Rect = first ? { ...ctx.getRect() } : (memo as Rect);
      if (first) ctx.onGestureActive(true);

      const { dx, dy } = scaledMovement(movement as [number, number], ctx.getScale());
      const next = clampRect({ ...base, x: base.x + dx, y: base.y + dy }, ctx.getBounds());
      ctx.onChange(next, last);

      if (last) ctx.onGestureActive(false);
      return base;
    },
    { ...WINDOW_DRAG_CONFIG, enabled: !ctx.disabled },
  );
}
