/**
 * Dock action factories for usePanelStore.
 *
 * Extracted to keep panel-store.ts under its 200-line budget. Each export is a
 * factory that receives (set, get) from the zustand store and returns the action
 * implementation — matching the existing closure style in panel-store.ts.
 *
 * The dock panel (__dock__) lives in the `panels` map but is intentionally excluded
 * from `grid`, so all grid math (MAX_ROWS, split, column count) never touches it.
 * That exclusion is an invariant this module must preserve: no action here ever
 * writes DOCK_PANEL_ID into `grid`.
 */
import type { StoreApi } from "zustand";
import type { Tab } from "./tab-store";
import type { Panel, DockState } from "./panel-utils";
import {
  DOCK_PANEL_ID,
  createDockPanel,
  savePanelLayout,
  deriveTabId,
} from "./panel-utils";
import type { PanelStore } from "./panel-store";

// ---------------------------------------------------------------------------
// Height clamping
// ---------------------------------------------------------------------------
const DOCK_HEIGHT_MIN = 15;
const DOCK_HEIGHT_MAX = 85;

function clampHeight(pct: number): number {
  return Math.min(DOCK_HEIGHT_MAX, Math.max(DOCK_HEIGHT_MIN, pct));
}

// ---------------------------------------------------------------------------
// History helper (mirrors panel-store.ts pushHistory)
// ---------------------------------------------------------------------------
function pushHistory(history: string[], id: string): string[] {
  const filtered = history.filter((h) => h !== id);
  filtered.push(id);
  if (filtered.length > 50) filtered.shift();
  return filtered;
}

// ---------------------------------------------------------------------------
// Action factories
// ---------------------------------------------------------------------------

type Set = StoreApi<PanelStore>["setState"];
type Get = StoreApi<PanelStore>["getState"];

/** Flip dock visible without touching height or tabs. */
export function makeToggleDock(set: Set, get: Get) {
  return function toggleDock(): void {
    const { dock } = get();
    set({ dock: { ...dock, visible: !dock.visible } });
    persistDock(get);
  };
}

/** Explicitly set dock visibility. */
export function makeSetDockVisible(set: Set, get: Get) {
  return function setDockVisible(visible: boolean): void {
    const { dock } = get();
    set({ dock: { ...dock, visible } });
    persistDock(get);
  };
}

/** Set dock height, clamped to [15, 85] percent. */
export function makeSetDockHeight(set: Set, get: Get) {
  return function setDockHeight(pct: number): void {
    const { dock } = get();
    set({ dock: { ...dock, height: clampHeight(pct) } });
    persistDock(get);
  };
}

/**
 * Open a tab inside the dock panel. Shows the dock automatically.
 *
 * Deduplication: if a tab with the same derived ID already exists in __dock__,
 * it is focused rather than duplicated (mirrors openTab dedup logic).
 */
export function makeOpenInDock(set: Set, get: Get) {
  return function openInDock(tabDef: Omit<Tab, "id">): string {
    const { panels, dock } = get();
    const dockPanel: Panel = panels[DOCK_PANEL_ID] ?? createDockPanel();

    // Compute terminal index if not provided (scan all panels including dock)
    let resolvedDef = tabDef;
    if (tabDef.type === "terminal" && !tabDef.metadata?.terminalIndex) {
      const allTabs = Object.values(panels).flatMap((p) => p.tabs);
      const termNums = allTabs
        .filter((t) => t.type === "terminal")
        .map((t) => {
          const m = t.id.match(/^terminal:(\d+)/);
          return m ? parseInt(m[1]!, 10) : 0;
        });
      const nextIndex = termNums.length > 0 ? Math.max(...termNums) + 1 : 1;
      resolvedDef = { ...tabDef, metadata: { ...tabDef.metadata, terminalIndex: nextIndex } };
    }

    const tabId = deriveTabId(resolvedDef.type, resolvedDef.metadata);

    // Dedup: focus existing tab if already in dock
    const existing = dockPanel.tabs.find((t) => t.id === tabId);
    if (existing) {
      set((s) => ({
        dock: { ...s.dock, visible: true },
        panels: {
          ...s.panels,
          [DOCK_PANEL_ID]: {
            ...dockPanel,
            activeTabId: tabId,
            tabHistory: pushHistory(dockPanel.tabHistory, tabId),
          },
        },
      }));
      persistDock(get);
      return tabId;
    }

    const newTab: Tab = { ...resolvedDef, id: tabId };
    const newTabs = [...dockPanel.tabs, newTab];
    const newHistory = pushHistory(dockPanel.tabHistory, tabId);

    set((s) => ({
      dock: { ...s.dock, visible: true },
      panels: {
        ...s.panels,
        [DOCK_PANEL_ID]: {
          ...dockPanel,
          tabs: newTabs,
          activeTabId: tabId,
          tabHistory: newHistory,
        },
      },
    }));
    persistDock(get);
    return tabId;
  };
}

// ---------------------------------------------------------------------------
// Re-dock: move a terminal tab from a grid panel back to __dock__ + show dock.
//
// Called by closeTab when a terminal is closed from a GRID panel.
// Closing a terminal from the grid PARKS it in the dock instead of killing it —
// real kill only happens when closed from WITHIN the dock, on shell exit, or
// after the idle/grace period expires.
//
// IMPORTANT: this function MUST NOT call closeTab (loop guard). It uses the
// low-level moveTab primitive directly via the store getter.
// ---------------------------------------------------------------------------
export function makeRedockTab(set: Set, get: Get) {
  return function redockTab(tabId: string, fromPanelId: string): void {
    // Delegate to the existing moveTab primitive. moveTab handles:
    //   - removing tab from source panel
    //   - appending to __dock__ tabs
    //   - auto-active + history update in __dock__
    //   - defensive guard: fromPanelId !== DOCK_PANEL_ID prevents grid-remove on dock source
    // moveTab does NOT strip the localStorage session key — session stays alive.
    get().moveTab(tabId, fromPanelId, DOCK_PANEL_ID);

    // Show dock so user sees the parked terminal
    const { dock } = get();
    set({ dock: { ...dock, visible: true } });
    persistDock(get);
  };
}

// ---------------------------------------------------------------------------
// Persist helper: writes current dock + dockPanel into localStorage alongside
// the grid panels. Called after every dock mutation.
// ---------------------------------------------------------------------------
export function persistDock(get: Get): void {
  const { currentProject, panels, grid, focusedPanelId, dock } = get();
  if (!currentProject) return;

  // Grid panels (existing persist logic mirrors panel-store.ts:persist())
  const panelIds = new Set(grid.flat());
  const projectPanels: Record<string, Panel> = {};
  for (const [id, p] of Object.entries(panels)) {
    if (panelIds.has(id)) projectPanels[id] = p;
  }

  savePanelLayout(currentProject, {
    panels: projectPanels,
    grid,
    focusedPanelId,
    dock,
    dockPanel: panels[DOCK_PANEL_ID] ?? createDockPanel(),
  });
}

/**
 * Snapshot current dock state into projectDock before a project switch.
 * Returns the updated projectDock map (caller merges into set()).
 */
export function snapshotDockForProject(
  currentProject: string,
  dock: DockState,
  projectDock: Record<string, DockState>,
): Record<string, DockState> {
  return { ...projectDock, [currentProject]: dock };
}

/**
 * Restore dock state for the target project from projectDock.
 * Defaults to hidden if this project has never had a dock state stored.
 */
export function restoreDockForProject(
  projectName: string,
  projectDock: Record<string, DockState>,
): DockState {
  return projectDock[projectName] ?? { visible: false, height: 30 };
}
