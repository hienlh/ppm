/**
 * Pure pill-visibility resolver for the dock header.
 *
 * Bottom position shows every pill with a label. Vertical positions (left/right)
 * render inactive pills icon-only and, when there are more than 2 tabs, collapse
 * to 2 pills (the active tab is always kept visible) plus a `+N` overflow chip
 * whose dropdown lists the remaining tabs. DOM-free so it is unit-testable.
 */
import type { DockPosition } from "@/stores/settings-store";

/** Max pills shown before overflowing, for vertical (left/right) positions. */
export const DOCK_PILL_CAP = 2;

export interface DockPillDisplay {
  /** Tab ids to render as pills, in original order. */
  visible: string[];
  /** Tab ids hidden behind the `+N` overflow chip, in original order. */
  overflow: string[];
  /** True when inactive pills should render icon-only (label in tooltip). */
  iconOnlyInactive: boolean;
}

export function resolveDockPills(
  tabIds: string[],
  activeId: string | null,
  position: DockPosition,
): DockPillDisplay {
  const iconOnlyInactive = position !== "bottom";

  // Bottom, or few enough tabs to show all → no overflow.
  if (position === "bottom" || tabIds.length <= DOCK_PILL_CAP) {
    return { visible: [...tabIds], overflow: [], iconOnlyInactive };
  }

  // Vertical + overflow: keep the active tab, then fill up to the cap with the
  // earliest remaining tabs. Preserve original order in both lists.
  const keep = new Set<string>();
  if (activeId && tabIds.includes(activeId)) keep.add(activeId);
  for (const id of tabIds) {
    if (keep.size >= DOCK_PILL_CAP) break;
    keep.add(id);
  }

  return {
    visible: tabIds.filter((id) => keep.has(id)),
    overflow: tabIds.filter((id) => !keep.has(id)),
    iconOnlyInactive,
  };
}
