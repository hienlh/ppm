/** Shared window types — split out so the store and the persistence layer do not import each other. */

import type { Rect } from "./window-geometry";

/**
 * Content families the layer can host. The registry maps each kind to its body component.
 * Single source of truth: the persistence layer filters this list instead of repeating it,
 * so a new kind can never be silently dropped on reload.
 */
export const WINDOW_KINDS = ["explorer", "team-member", "system-monitor", "tab-host"] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

export type WindowVisualState = "normal" | "maximized" | "minimized";

export interface WindowRuntimeState {
  id: string;
  kind: WindowKind;
  /** Geometry in layer coordinates. While maximized this holds the restore rect. */
  rect: Rect;
  /** Dense stacking order, 0 = backmost, renormalised on every focus. */
  rank: number;
  state: WindowVisualState;
  /** Kind-specific, must stay JSON-serialisable to survive a reload. */
  payload?: Record<string, unknown>;
}
