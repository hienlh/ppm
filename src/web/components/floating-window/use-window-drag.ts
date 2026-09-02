/** Titlebar drag: moves a window, committing to the store only when the gesture ends. */

import { useDrag } from "@use-gesture/react";
import { clampRect, type Rect } from "./window-geometry";
import {
  gestureDisplacement,
  WINDOW_DRAG_CONFIG,
  type WindowGestureContext,
} from "./use-window-gesture-context";

export function useWindowDrag(ctx: WindowGestureContext) {
  return useDrag(
    ({ xy, initial, first, last, memo }) => {
      // The rect is captured once per gesture: the displacement is cumulative from the
      // start, so re-reading a rect that we ourselves are mutating would compound it.
      const base: Rect = first ? { ...ctx.getRect() } : (memo as Rect);
      if (first) ctx.onGestureActive(true);

      const { dx, dy } = gestureDisplacement(xy, initial, ctx.getScale());
      const next = clampRect({ ...base, x: base.x + dx, y: base.y + dy }, ctx.getBounds());
      ctx.onChange(next, last);

      if (last) ctx.onGestureActive(false);
      return base;
    },
    { ...WINDOW_DRAG_CONFIG, enabled: !ctx.disabled },
  );
}
