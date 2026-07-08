/**
 * tab-pool-collect.ts — pure tab-collection logic extracted from tab-pool.tsx.
 *
 * WHY extracted: the collectFromGrid function inside TabPool is not testable
 * without a DOM because TabPool is a React component. Extracting it as a pure
 * function lets us characterize the collection contract in a unit test
 * (tests/unit/stores/panel-store-keepalive.test.ts) before phase 03 extends
 * it with dock support.
 *
 * Behavior is IDENTICAL to the inline collectFromGrid in tab-pool.tsx — the
 * characterization test proves it by asserting the same outputs.
 */
import type { Panel } from "@/stores/panel-utils";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";
import type { TabType } from "@/stores/tab-store";

export interface TabEntry {
  tabId: string;
  panelId: string;
  type: TabType;
  metadata?: Record<string, unknown>;
  isActive: boolean;
}

/**
 * Collect tab entries from a single project grid, deduplicating by tabId via
 * the shared seenTabs set (passed in so the caller can call this for multiple
 * projects and keep the global dedup invariant).
 *
 * Rules locked here (current behavior on main):
 * - Skip tabs whose tabId is already in seenTabs (dedup across project grids).
 * - Skip tabs whose projectId doesn't match projectName (race-condition guard).
 * - Skip extension/extension-webview tabs from non-active projects (cross-project
 *   server recovery causes spurious tab creation — tab-pool.tsx:114).
 */
export function collectFromGrid(
  projectGrid: string[][],
  projectName: string | null,
  isActiveProject: boolean,
  panels: Record<string, Panel>,
  seenTabs: Set<string>,
  tabEntries: TabEntry[],
): void {
  for (const panelId of projectGrid.flat()) {
    const panel = panels[panelId];
    if (!panel) continue;
    for (const tab of panel.tabs) {
      if (seenTabs.has(tab.id)) continue;
      // Skip tabs from other projects (race condition in openTab during project switch)
      if (tab.projectId && projectName && tab.projectId !== projectName) continue;
      // Don't keep-alive extension tabs from non-active projects — their
      // server-side recovery mechanism causes cross-project tab creation
      if (!isActiveProject && (tab.type === "extension" || tab.type === "extension-webview")) continue;
      seenTabs.add(tab.id);
      tabEntries.push({
        tabId: tab.id,
        panelId,
        type: tab.type,
        metadata: tab.metadata,
        isActive: tab.id === panel.activeTabId,
      });
    }
  }
}

/**
 * Collect tab entries from the shared dock panel (__dock__), deduplicating
 * via seenTabs.
 *
 * WHY called after grid + projectGrids: the seenTabs set already contains every
 * tabId collected from grid panels when this runs. If a tab was recently moved
 * FROM the dock INTO a grid panel (or vice-versa during a move operation), the
 * grid entry wins because it was collected first. This ensures the tab renders
 * in the grid slot rather than the dock slot — the correct visual outcome when
 * a tab is live in a grid panel.
 *
 * WHY no projectId filter: the dock panel is shared across projects. Filtering
 * by active project here would unmount other projects' terminals on project
 * switch. Instead, visibility filtering (which project's tab is shown in the
 * dock slot) happens at render time. This mirrors how grid keep-alive collects
 * all projects' panels regardless of currentProject.
 */
export function collectFromDock(
  dockPanel: Panel,
  seenTabs: Set<string>,
  tabEntries: TabEntry[],
): void {
  for (const tab of dockPanel.tabs) {
    if (seenTabs.has(tab.id)) continue;
    seenTabs.add(tab.id);
    tabEntries.push({
      tabId: tab.id,
      panelId: DOCK_PANEL_ID,
      type: tab.type,
      metadata: tab.metadata,
      isActive: tab.id === dockPanel.activeTabId,
    });
  }
}

/**
 * Collect all tab entries across active and non-active projects, returning
 * the full deduplicated list (sorted by tabId for stable ordering).
 *
 * Collection order (intentional — determines dedup precedence):
 *   1. Active project's live grid  (highest priority)
 *   2. Non-active projects' snapshotted grids  (keep-alive)
 *   3. Dock panel (__dock__)  (lowest priority — grid wins on collision)
 *
 * This mirrors what TabPool does before passing entries to ReparentingTab.
 */
export function collectTabEntries(
  panels: Record<string, Panel>,
  grid: string[][],
  projectGrids: Record<string, string[][]>,
  currentProject: string | null,
): TabEntry[] {
  const tabEntries: TabEntry[] = [];
  const seenTabs = new Set<string>();

  // Active project uses the live grid
  collectFromGrid(grid, currentProject, true, panels, seenTabs, tabEntries);

  // Non-active projects use their snapshotted grids (keep-alive)
  for (const [projectName, projectGrid] of Object.entries(projectGrids)) {
    if (projectName === currentProject) continue;
    collectFromGrid(projectGrid, projectName, false, panels, seenTabs, tabEntries);
  }

  // Dock panel — collected last so grid tabs always win dedup.
  // Missing __dock__ (e.g. legacy state, tests without dock) is safe to skip.
  const dockPanel = panels[DOCK_PANEL_ID];
  if (dockPanel) {
    collectFromDock(dockPanel, seenTabs, tabEntries);
  }

  // Stable key order — mirrors tab-pool.tsx sort to prevent React reorder
  tabEntries.sort((a, b) => a.tabId.localeCompare(b.tabId));
  return tabEntries;
}
