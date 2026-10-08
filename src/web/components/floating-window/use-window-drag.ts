/**
 * Titlebar drag: moves a window, committing to the store only when the gesture ends.
 *
 * Dragging a window's right edge past the layer's right edge (see `wantsSnap`) arms a snap:
 * the layer shows where the window would go, and releasing there snaps it instead of
 * committing the move.
 */

import { useDrag } from "@use-gesture/react";
import { clampRect, wantsSnap, type Rect } from "./window-geometry";
import {
  gestureAbandoned,
  gestureDisplacement,
  WINDOW_DRAG_CONFIG,
  type WindowGestureContext,
} from "./use-window-gesture-context";

export interface WindowDragContext extends WindowGestureContext {
  /** Told whether releasing now would snap; called only when the answer changes. */
  onSnapPreview?: (armed: boolean) => void;
  /** Released while armed: the window snaps and the move is not committed. */
  onSnap?: () => void;
}

export function useWindowDrag(ctx: WindowDragContext) {
  return useDrag(
    ({ xy, initial, first, last, memo }) => {
      if (gestureAbandoned(first, memo)) {
        if (last) ctx.onGestureActive(false);
        return;
      }
      // The rect is captured once per gesture: the displacement is cumulative from the
      // start, so re-reading a rect that we ourselves are mutating would compound it.
      const state = first ? { base: { ...ctx.getRect() }, armed: false } : (memo as { base: Rect; armed: boolean });
      const { base } = state;
      if (first) ctx.onGestureActive(true);

      const { dx, dy } = gestureDisplacement(xy, initial, ctx.getScale());
      const moved = { ...base, x: base.x + dx, y: base.y + dy };
      const bounds = ctx.getBounds();
      const armed = Boolean(ctx.onSnap) && wantsSnap(moved, base, bounds);
      if (armed !== state.armed) {
        state.armed = armed;
        ctx.onSnapPreview?.(armed);
      }

      if (last && armed) {
        ctx.onSnapPreview?.(false);
        ctx.onSnap?.();
      } else {
        ctx.onChange(clampRect(moved, bounds), last);
      }

      if (last) ctx.onGestureActive(false);
      return state;
    },
    { ...WINDOW_DRAG_CONFIG, enabled: !ctx.disabled },
  );
}
