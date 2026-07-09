/**
 * Pure layout resolver for the position-configurable panel dock.
 *
 * Kept DOM-free so it is unit-testable without a render harness. `panel-layout.tsx`
 * consumes this to decide the react-resizable-panels Group orientation, the
 * grid/dock render order, the dock's default size, and which edge carries the
 * content-facing hairline border.
 */
import type { DockPosition } from "@/stores/settings-store";

/** Maximized dock size (percent of the main area). */
export const DOCK_EXPANDED_BOTTOM = 70;
export const DOCK_EXPANDED_SIDE = 55;

export interface DockLayoutConfig {
  /** Group orientation: bottom stacks vertically; left/right split horizontally. */
  orientation: "vertical" | "horizontal";
  /** True when the dock Panel renders BEFORE the grid Panel (left position). */
  dockFirst: boolean;
  /** Dock Panel default size as a `%` string (bare numbers = px in RRP v4). */
  dockSize: string;
  /** Which edge of the dock carries the hairline border (the edge facing content). */
  borderEdge: "top" | "left" | "right";
}

/**
 * Resolve the dock layout from its position + persisted size ratio + maximize flag.
 * `sizeRatio` is the user-resizable percentage (reused for both height and width).
 */
export function resolveDockLayout(
  position: DockPosition,
  sizeRatio: number,
  expanded: boolean,
): DockLayoutConfig {
  if (position === "bottom") {
    return {
      orientation: "vertical",
      dockFirst: false,
      dockSize: `${expanded ? DOCK_EXPANDED_BOTTOM : sizeRatio}%`,
      borderEdge: "top",
    };
  }
  // left / right → horizontal split
  return {
    orientation: "horizontal",
    dockFirst: position === "left",
    dockSize: `${expanded ? DOCK_EXPANDED_SIDE : sizeRatio}%`,
    // Border sits on the edge facing the grid: left dock → right edge; right dock → left edge.
    borderEdge: position === "left" ? "right" : "left",
  };
}
