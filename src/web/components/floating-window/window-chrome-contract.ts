/**
 * Contract between the window frame and whatever draws its titlebar.
 *
 * The frame owns geometry, gestures and keyboard handling; a chrome implementation owns
 * only the look. Everything a titlebar needs to be draggable and operable arrives in
 * `titlebarProps` — a chrome that spreads it gets drag, focus and keyboard for free.
 */

import type { ComponentType, ElementType, HTMLAttributes, ReactNode } from "react";
import type { WindowKind, WindowVisualState } from "./window-store-types";

/** What a titlebar says about its window beyond the title; see `useWindowMeta`. */
export interface WindowChromeIdentity {
  /** The window's own glyph, drawn on a tile tinted with `tone`. */
  icon: ElementType;
  /** A CSS colour (a theme token); designs get one of their own. */
  tone: string;
  /** Second, dimmer label after the title, e.g. "Design · ppm". */
  subtitle?: string;
  /** Something is running in the window (an AI turn); the titlebar says so. */
  busy: boolean;
  /** False for content that must not move into picture-in-picture (a design canvas). */
  allowPip: boolean;
  /**
   * Buttons the hosted tab adds to the titlebar, left of the caption buttons (the Assistant's
   * settings gear, "Open in project"); see `tab-window-extras-registry.ts`.
   */
  renderExtras?: (skin: "windows" | "macos") => ReactNode;
  /** A count wanting attention (the Assistant's waiting cards), shown on the dock chip. */
  count?: number;
  /** The titlebar says "Idle" when nothing runs, not only "Working" when something does. */
  showIdle?: boolean;
}

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
  identity: WindowChromeIdentity;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  /** Snap to the right part of the layer, or back from it. */
  onToggleSnap: () => void;
  onClose: () => void;
}

/**
 * Rendered as an element by the frame, so a skin owns its own hooks and state (hover and
 * focus handling for traffic lights, animation, its own effects) without touching the
 * frame's hook order.
 */
export type WindowChrome = ComponentType<WindowChromeProps>;

/** Titlebar height; a picture-in-picture window takes it off the requested height. */
export const TITLEBAR_HEIGHT = 36;
