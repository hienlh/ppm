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
import { DOCK_PANEL_ID, gridRemovePanel, isWindowPanelId } from "./panel-utils";

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

interface KeptLayouts {
  panels: Record<string, Panel>;
  projectGrids: Record<string, string[][]>;
  projectFocused: Record<string, string>;
  currentProject: string | null;
}

/**
 * What to commit once `panelId`, a panel off the open grid (not the dock, not a window), has
 * lost its last tab: off the kept grid of the project that owns it, and that project's focus
 * moved off it — else switching back would focus a panel that is gone, and the next tab opened
 * there would open nowhere. Null when it is that grid's last panel: it stays, empty. A panel no
 * grid holds is simply dropped. The open project's own entry in `projectGrids` is skipped: it is
 * the snapshot taken when it was loaded, not its grid.
 */
export function withoutEmptiedOffGridPanel(s: KeptLayouts, panelId: string): Partial<KeptLayouts> | null {
  const { [panelId]: _gone, ...panels } = s.panels;
  const owner = Object.keys(s.projectGrids).find((project) =>
    project !== s.currentProject && s.projectGrids[project]!.some((row) => row.includes(panelId)));
  if (!owner) return { panels };
  const kept = s.projectGrids[owner]!;
  if (kept.flat().length <= 1) return null;
  const grid = gridRemovePanel(kept, panelId);
  const focused = s.projectFocused[owner];
  return {
    panels,
    projectGrids: { ...s.projectGrids, [owner]: grid },
    projectFocused: { ...s.projectFocused, [owner]: focused && focused !== panelId ? focused : grid.flat()[0]! },
  };
}
