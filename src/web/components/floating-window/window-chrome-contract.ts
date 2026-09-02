/**
 * Contract between the window frame and whatever draws its titlebar.
 *
 * The frame owns geometry, gestures and keyboard handling; a chrome implementation owns
 * only the look. Everything a titlebar needs to be draggable and operable arrives in
 * `titlebarProps` — a chrome that spreads it gets drag, focus and keyboard for free.
 */

import type { ComponentType, HTMLAttributes } from "react";
import type { WindowKind, WindowVisualState } from "./window-store-types";

export interface WindowChromeProps {
  id: string;
  kind: WindowKind;
  title: string;
  state: WindowVisualState;
  /** True when this window is frontmost — chrome should dim its titlebar otherwise. */
  focused: boolean;
  /**
   * Spread on the titlebar element. Carries the drag recogniser, the keyboard handler,
   * `tabIndex`, and the `touch-action`/`user-select` suppression the gesture needs.
   * A chrome may append its own className/style; it must not drop these.
   */
  titlebarProps: HTMLAttributes<HTMLElement> & { tabIndex: number };
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

/**
 * Rendered as an element by the frame, so a skin owns its own hooks and state (hover and
 * focus handling for traffic lights, animation, its own effects) without touching the
 * frame's hook order.
 */
export type WindowChrome = ComponentType<WindowChromeProps>;

/** Titlebar height the frame reserves when a window is collapsed (minimised). */
export const TITLEBAR_HEIGHT = 36;
