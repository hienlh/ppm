/** Shared window types — split out so the store and the persistence layer do not import each other. */

import type { Rect } from "./window-geometry";

/**
 * Content families the layer can host. The registry maps each kind to its body component.
 * Single source of truth: the persistence layer filters this list instead of repeating it,
 * so a new kind can never be silently dropped on reload.
 */
export const WINDOW_KINDS = ["explorer", "agent-session", "system-monitor", "tab-host", "remote-desktop", "settings", "logs"] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

/**
 * `snapped` fills the right part of the layer (see `snapRect`); `minimized` takes the window
 * off screen entirely and leaves it as a chip in the status bar's window dock.
 */
export type WindowVisualState = "normal" | "maximized" | "snapped" | "minimized";

/** Every state a window can be brought back to from the dock. */
export type WindowShownState = Exclude<WindowVisualState, "minimized">;

export interface WindowRuntimeState {
  id: string;
  kind: WindowKind;
  /** Geometry in layer coordinates. While maximized or snapped this holds the restore rect. */
  rect: Rect;
  /** Dense stacking order, 0 = backmost, renormalised on every focus. */
  rank: number;
  /** When the window was opened, relative to the others: the dock lists chips in this order. */
  opened: number;
  state: WindowVisualState;
  /** What a minimized window comes back as; absent means `normal`. */
  restoreTo?: WindowShownState;
  /** Kind-specific, must stay JSON-serialisable to survive a reload. */
  payload?: Record<string, unknown>;
}
