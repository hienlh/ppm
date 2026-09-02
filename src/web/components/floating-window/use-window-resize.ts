/**
 * Eight-direction resize. One `useDrag` instance is bound per handle via `bind(handle)`;
 * the handle id arrives in `args`, so all eight edges share a single recogniser.
 */

import { useDrag } from "@use-gesture/react";
import { applyResize, clampRect, type Rect, type ResizeHandle } from "./window-geometry";
import {
  gestureDisplacement,
  WINDOW_DRAG_CONFIG,
  type WindowGestureContext,
} from "./use-window-gesture-context";

export function useWindowResize(ctx: WindowGestureContext) {
  return useDrag(
    ({ args, xy, initial, first, last, memo }) => {
      const handle = args[0] as ResizeHandle;
      const base: Rect = first ? { ...ctx.getRect() } : (memo as Rect);
      if (first) ctx.onGestureActive(true);

      const { dx, dy } = gestureDisplacement(xy, initial, ctx.getScale());
      const next = clampRect(applyResize(base, handle, dx, dy), ctx.getBounds());
      ctx.onChange(next, last);

      if (last) ctx.onGestureActive(false);
      return base;
    },
    { ...WINDOW_DRAG_CONFIG, enabled: !ctx.disabled },
  );
}
