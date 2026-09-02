/**
 * Contract between the window frame and whatever draws its titlebar.
 *
 * The frame owns geometry, gestures and keyboard handling; a chrome implementation owns
 * only the look. Everything a titlebar needs to be draggable and operable arrives in
 * `titlebarProps` — a chrome that spreads it gets drag, focus and keyboard for free.
 */

import type { HTMLAttributes } from "react";
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
 * Called inline by the window frame, so a renderer must behave like a plain render function:
 * a skin that needs hooks or state should return its own component element rather than
 * calling hooks here, where the frame owns the hook order.
 */
export type WindowChromeRenderer = (props: WindowChromeProps) => React.ReactNode;

/** Titlebar height the frame reserves when a window is collapsed (minimised). */
export const TITLEBAR_HEIGHT = 36;
