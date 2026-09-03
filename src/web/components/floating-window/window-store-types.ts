/** Shared window types — split out so the store and the persistence layer do not import each other. */

import type { Rect } from "./window-geometry";

/** Content families the layer can host. The registry maps each kind to its body component. */
export type WindowKind = "explorer" | "team-member";

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
