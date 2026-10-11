/**
 * Bringing a one-of-a-kind tab with no project onto the grid that is on screen.
 *
 * Every project keeps its own grid, and switching project only swaps which grid renders: the
 * other projects' panels stay in the `panels` map, keep-alive. A singleton such as the
 * Assistant belongs to no project, so it lives in whichever grid it was opened from — and
 * "focus the existing one" used to activate it inside a grid nobody can see. On a phone
 * (no floating windows) that made the Assistant unreachable after a project switch.
 *
 * Pure functions only, so the decision can be tested without the store.
 */
import type { Panel } from "./panel-utils";
import { DOCK_PANEL_ID, isWindowPanelId } from "./panel-utils";

/** Whether a panel is rendered right now: on the visible grid, the dock, or (desktop) a window. */
export function isPanelOnScreen(panelId: string, grid: string[][], mobile: boolean): boolean {
  if (panelId === DOCK_PANEL_ID) return true;
  if (isWindowPanelId(panelId)) return !mobile;
  return grid.some((row) => row.includes(panelId));
}

/** The project whose remembered grid holds `panelId`, or null when no project's does. */
export function projectOwningPanel(projectGrids: Record<string, string[][]>, panelId: string): string | null {
  for (const [project, grid] of Object.entries(projectGrids)) {
    if (grid.some((row) => row.includes(panelId))) return project;
  }
  return null;
}

/**
 * Move `tabId` from `fromPanelId` to `toPanelId` and make it the target's active tab.
 *
 * Unlike `moveTab`, the emptied source is never dropped: it belongs to another project's
 * remembered grid, and deleting it would leave that grid naming a panel that no longer
 * exists. An empty panel there renders the ordinary empty state instead.
 */
export function relocateTab(
  panels: Record<string, Panel>,
  tabId: string,
  fromPanelId: string,
  toPanelId: string,
): Record<string, Panel> {
  const from = panels[fromPanelId];
  const to = panels[toPanelId];
  if (!from || !to || fromPanelId === toPanelId) return panels;
  const tab = from.tabs.find((t) => t.id === tabId);
  if (!tab) return panels;

  const fromTabs = from.tabs.filter((t) => t.id !== tabId);
  const fromHistory = from.tabHistory.filter((id) => id !== tabId);
  const fromActive = from.activeTabId === tabId
    ? (fromHistory[fromHistory.length - 1] ?? fromTabs[fromTabs.length - 1]?.id ?? null)
    : from.activeTabId;

  return {
    ...panels,
    [fromPanelId]: { ...from, tabs: fromTabs, tabHistory: fromHistory, activeTabId: fromActive },
    [toPanelId]: {
      ...to,
      tabs: [...to.tabs.filter((t) => t.id !== tabId), tab],
      tabHistory: [...to.tabHistory.filter((id) => id !== tabId), tabId],
      activeTabId: tabId,
    },
  };
}
