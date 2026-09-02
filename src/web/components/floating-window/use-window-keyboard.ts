/**
 * Keyboard operation for a focused titlebar — the accessible path for users who cannot drag.
 *
 * Arrows nudge (Shift = 1 px), Alt+Enter toggles maximize, Escape closes. There is
 * deliberately no Ctrl/Cmd+W: Chromium reserves it for the browser tab outside PWA and
 * fullscreen contexts and ignores preventDefault, so binding it would close the app instead.
 */

import { useCallback } from "react";
import type { KeyboardEvent } from "react";
import { nudgeRect, type Bounds, type Rect } from "./window-geometry";

const NUDGE = 10;
const NUDGE_FINE = 1;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export interface WindowKeyboardActions {
  getRect: () => Rect;
  getBounds: () => Bounds;
  onMove: (rect: Rect) => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  /** Nudging a maximized window would fight the layout, so it is ignored. */
  movable: boolean;
}

export function useWindowKeyboard(actions: WindowKeyboardActions) {
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        actions.onClose();
        return;
      }
      if (e.altKey && e.key === "Enter") {
        e.preventDefault();
        actions.onToggleMaximize();
        return;
      }
      const dir = ARROWS[e.key];
      if (!dir || !actions.movable) return;
      // Arrows would otherwise scroll the panel behind the window.
      e.preventDefault();
      const step = e.shiftKey ? NUDGE_FINE : NUDGE;
      actions.onMove(nudgeRect(actions.getRect(), dir[0] * step, dir[1] * step, actions.getBounds()));
    },
    [actions],
  );
}
