import { create } from "zustand";
import type { Tab, TabType } from "./tab-store";
import {
  type Panel,
  type PanelLayout,
  type DockState,
  createPanel,
  createDockPanel,
  gridAddColumn,
  gridAddRow,
  gridRemovePanel,
  findPanelPosition,
  maxColumns,
  MAX_ROWS,
  savePanelLayout,
  loadPanelLayout,
  deriveTabId,
  visibleTabs,
  DOCK_PANEL_ID,
  isWindowPanelId,
} from "./panel-utils";
import {
  makePopOutTab,
  makeRedockFromWindow,
  hydrateWindowPanels,
  stripProjectFromWindowPanels,
  syncWindowPanel,
} from "./window-panel-actions";
import { saveWindowPanels } from "./window-panel-persistence";
import { useWindowStore } from "@/components/floating-window/window-store";
import {
  makeToggleDock,
  makeSetDockVisible,
  makeSetDockHeight,
  makeOpenInDock,
  makeRedockTab,
  persistDock,
  snapshotDockForProject,
  restoreDockForProject,
  collapseRestoredDockOnMobile,
  activeProjectDockTabCount,
} from "./dock-actions";

/** Tab types that can only have 1 instance per project */
const SINGLETON_TYPES = new Set<TabType>(["settings", "git-log"]);

/** Tab types removed in a prior version — filter them out when loading persisted state */
const OBSOLETE_TAB_TYPES = new Set(["projects", "git-status", "git-graph"]);

/**
 * The shared __dock__ panel holds tabs from all projects. When the active
 * project changes, its rendered active tab must belong to that project —
 * otherwise the dock slot would show another project's terminal until the user
 * clicks a tab. Pick the most-recent dock tab (by history) for the project.
 */
function pickDockActiveTab(dockPanel: Panel | undefined, projectName: string): string | null {
  if (!dockPanel) return null;
  const projTabs = dockPanel.tabs.filter((t) => !t.projectId || t.projectId === projectName);
  if (projTabs.length === 0) return null;
  for (let i = dockPanel.tabHistory.length - 1; i >= 0; i--) {
    const id = dockPanel.tabHistory[i]!;
    if (projTabs.some((t) => t.id === id)) return id;
  }
  return projTabs[projTabs.length - 1]!.id;
}

function pushHistory(history: string[], id: string): string[] {
  const filtered = history.filter((h) => h !== id);
  filtered.push(id);
  if (filtered.length > 50) filtered.shift();
  return filtered;
}

// Stamp the just-activated tab with a wall-clock time. The mobile tab-switcher's
// "Recent" sort needs a GLOBAL most-recently-active order across split panels;
// per-panel tabHistory can't be merged into one because it has no cross-panel
// timestamp. Date.now() is monotonic enough across reloads (it persists with the
// tab), so the active tab always sorts first even after a refresh.
function stampActive(tabs: Tab[], id: string): Tab[] {
  const now = Date.now();
  return tabs.map((t) => (t.id === id ? { ...t, metadata: { ...t.metadata, lastActiveAt: now } } : t));
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------
export interface PanelStore {
  panels: Record<string, Panel>;
  grid: string[][];
  focusedPanelId: string;
  currentProject: string | null;

  /** Keep-alive: per-project grid snapshots (for hidden workspaces) */
  projectGrids: Record<string, string[][]>;
  projectFocused: Record<string, string>;

  /** Dock visibility + height for the currently active project. */
  dock: DockState;
  /** Per-project dock state snapshots (mirrors projectGrids pattern). */
  projectDock: Record<string, DockState>;
  /** Dock maximized (session-only — never persisted, resets on reload). */
  dockExpanded: boolean;

  // Project lifecycle
  switchProject: (projectName: string) => void;
  reloadProject: (projectName: string) => void;

  // Panel focus
  setFocusedPanel: (panelId: string) => void;

  // Tab operations (operate on focused panel by default)
  openTab: (tab: Omit<Tab, "id">, panelId?: string) => string;
  closeTab: (tabId: string, panelId?: string) => void;
  setActiveTab: (tabId: string, panelId?: string) => void;
  updateTab: (tabId: string, updates: Partial<Omit<Tab, "id">>) => void;

  // Panel operations
  reorderTab: (tabId: string, panelId: string, newIndex: number) => void;
  moveTab: (tabId: string, fromPanelId: string, toPanelId: string, insertIndex?: number) => void;
  splitPanel: (direction: "left" | "right" | "up" | "down", tabId: string, sourcePanelId: string, targetPanelId?: string) => boolean;
  closePanel: (panelId: string) => void;

  // Dock actions
  toggleDock: () => void;
  setDockVisible: (visible: boolean) => void;
  setDockHeight: (pct: number) => void;
  /** Toggle dock maximize (session-only). */
  toggleDockExpanded: () => void;
  openInDock: (tab: Omit<Tab, "id">) => string;
  /** Park a terminal from a grid panel into __dock__ without killing the PTY session. */
  redockTab: (tabId: string, fromPanelId: string) => void;

  // Floating-window actions
  /**
   * Detach a tab into a floating window, returning the window id — or null when the
   * request is rejected (mobile, a tab type that cannot detach, or the window cap),
   * in which case nothing changed and the caller reports it.
   */
  popOutTab: (tabId: string, fromPanelId: string) => string | null;
  /** Send a window's tabs back to the grid and drop its panel. Runs on window close. */
  redockFromWindow: (windowId: string, originPanelId?: string | null) => void;

  // Helpers
  getPanelForTab: (tabId: string) => Panel | undefined;
  isMobile: () => boolean;
}

function defaultLayout(): { panels: Record<string, Panel>; grid: string[][]; focusedPanelId: string } {
  const panel = createPanel();
  // Dock panel is seeded into panels but deliberately absent from grid —
  // grid math (MAX_ROWS, split, column count) must never see DOCK_PANEL_ID.
  const dockPanel = createDockPanel();
  return {
    panels: { [panel.id]: panel, [DOCK_PANEL_ID]: dockPanel },
    grid: [[panel.id]],
    focusedPanelId: panel.id,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const usePanelStore = create<PanelStore>()((set, get) => {
  /** Save only the active project's panels to localStorage.
   *
   * The dock panel lives in `panels` but NOT in `grid`, so grid.flat() would drop it.
   * We explicitly include it via the `dockPanel` field in PanelLayout.
   */
  function persist() {
    const { currentProject, panels, grid, focusedPanelId, dock } = get();
    if (!currentProject) return;
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
      dockPanel: panels[DOCK_PANEL_ID],
    });
  }

  function findPanel(tabId: string): Panel | undefined {
    return Object.values(get().panels).find((p) => p.tabs.some((t) => t.id === tabId));
  }

  function resolvePanel(panelId?: string): string {
    return panelId ?? get().focusedPanelId;
  }

  /**
   * The focus to commit when a tab was activated in `pid`.
   *
   * Focus decides where the next `openTab()` with no explicit panel lands, and a
   * floating window renders no tab bar — a tab opened inside one would be unreachable
   * until the window closes, and the id would be persisted with the layout. So
   * activating a tab that lives in a window leaves focus where it was: the window is
   * already in front of the user, nothing more is needed to "focus" it.
   *
   * Every caller here picks `pid` by scanning the whole `panels` map, which includes
   * the off-grid window panels.
   */
  function focusAfterActivate(pid: string): string {
    return isWindowPanelId(pid) ? get().focusedPanelId : pid;
  }

  return {
    ...defaultLayout(),
    currentProject: null,
    projectGrids: {},
    projectFocused: {},
    dock: { visible: false, height: 30 },
    projectDock: {},
    dockExpanded: false,

    // Dock actions — factories receive (set, get) matching the closure style
    toggleDock: makeToggleDock(set, get),
    setDockVisible: makeSetDockVisible(set, get),
    setDockHeight: makeSetDockHeight(set, get),
    // Session-only maximize — no persist (mirrors dockExpanded field doc).
    toggleDockExpanded: () => set((s) => ({ dockExpanded: !s.dockExpanded })),
    openInDock: makeOpenInDock(set, get),
    redockTab: makeRedockTab(set, get),
    popOutTab: makePopOutTab(set, get),
    redockFromWindow: makeRedockFromWindow(set, get),

    switchProject: (projectName) => {
      // Window panels are global, not part of any project's layout blob, so they are
      // merged into the flat map once — before the first project reads it.
      hydrateWindowPanels(set, get);
      const { currentProject, panels, grid, focusedPanelId, projectGrids, projectFocused, dock, projectDock } = get();

      // No-op if same project
      if (currentProject === projectName) return;

      // Snapshot current project's state (grid + dock)
      const newProjectGrids = { ...projectGrids };
      const newProjectFocused = { ...projectFocused };
      // Snapshot dock into projectDock; __dock__ panel stays alive in panels map across switches
      const newProjectDock = currentProject
        ? snapshotDockForProject(currentProject, dock, projectDock)
        : { ...projectDock };

      if (currentProject) {
        newProjectGrids[currentProject] = grid;
        newProjectFocused[currentProject] = focusedPanelId;
        // Persist to localStorage (include dock + dockPanel for current project)
        const panelIds = new Set(grid.flat());
        const currentPanels: Record<string, Panel> = {};
        for (const [id, p] of Object.entries(panels)) {
          if (panelIds.has(id)) currentPanels[id] = p;
        }
        savePanelLayout(currentProject, {
          panels: currentPanels,
          grid,
          focusedPanelId,
          dock,
          dockPanel: panels[DOCK_PANEL_ID],
        });
      }

      // Already in memory → restore from snapshot (no localStorage read)
      if (newProjectGrids[projectName]) {
        const restoredGrid = newProjectGrids[projectName]!;
        const restoredFocused = newProjectFocused[projectName] ?? restoredGrid[0]?.[0] ?? "";
        // Restore dock state for target project; __dock__ panel stays in panels (keep-alive).
        // Point the shared dock panel's active tab at THIS project's tab so the slot
        // doesn't render another project's terminal after the switch.
        const restoredDock = restoreDockForProject(projectName, newProjectDock);
        const existingDockPanel = panels[DOCK_PANEL_ID];
        const nextPanels = existingDockPanel
          ? { ...panels, [DOCK_PANEL_ID]: { ...existingDockPanel, activeTabId: pickDockActiveTab(existingDockPanel, projectName) } }
          : panels;
        set({
          currentProject: projectName,
          panels: nextPanels,
          grid: restoredGrid,
          focusedPanelId: restoredFocused,
          projectGrids: newProjectGrids,
          projectFocused: newProjectFocused,
          dock: restoredDock,
          projectDock: newProjectDock,
        });
        return;
      }

      // Load from localStorage
      const loaded = loadPanelLayout(projectName);
      if (loaded && Object.keys(loaded.panels).length > 0) {
        // Migrate: drop obsolete tab types, and tabs belonging to another project.
        // A foreign tab is filtered out of the tab bar, so it can never be closed —
        // and closeTab is the only thing that removes an emptied panel, so leaving
        // one behind wedges its panel permanently (it renders as a blank slot).
        let healed = false;
        const migratedPanels: typeof loaded.panels = {};
        for (const [pid, panel] of Object.entries(loaded.panels)) {
          const filteredTabs = visibleTabs(panel.tabs, projectName)
            .filter((t) => !OBSOLETE_TAB_TYPES.has(t.type));
          if (filteredTabs.length !== panel.tabs.length) healed = true;
          const filteredHistory = panel.tabHistory.filter(
            (id) => filteredTabs.some((t) => t.id === id),
          );
          const activeTabId = panel.activeTabId && filteredTabs.some((t) => t.id === panel.activeTabId)
            ? panel.activeTabId
            : (filteredHistory[filteredHistory.length - 1] ?? filteredTabs[0]?.id ?? null);
          migratedPanels[pid] = { ...panel, tabs: filteredTabs, tabHistory: filteredHistory, activeTabId };
        }

        // Apply the "no empty panel" invariant on restore, not just in closeTab:
        // the filtering above can empty a panel, and a grid id with no panel behind
        // it renders nothing either. The last panel always stays — the grid needs
        // something to render into.
        let migratedGrid = loaded.grid;
        for (const pid of migratedGrid.flat()) {
          if ((migratedPanels[pid]?.tabs.length ?? 0) > 0) continue;
          if (migratedGrid.flat().length <= 1) break;
          migratedGrid = gridRemovePanel(migratedGrid, pid);
          delete migratedPanels[pid];
          healed = true;
        }
        const migratedFocused = migratedGrid.flat().includes(loaded.focusedPanelId)
          ? loaded.focusedPanelId
          : (migratedGrid.flat()[0] ?? loaded.focusedPanelId);

        // Merge into flat panels map (keep-alive: old panels stay).
        // The shared __dock__ panel holds live tabs from ALL projects — union the
        // loaded project's persisted dock tabs into it rather than replacing, so a
        // different project's live terminal (its xterm/PTY) is never dropped on the
        // first switch to a not-yet-loaded project.
        const existingDock = panels[DOCK_PANEL_ID] ?? createDockPanel();
        const incomingDock = loaded.dockPanel ?? createDockPanel();
        const mergedDockTabs = [...existingDock.tabs];
        for (const t of incomingDock.tabs) {
          if (!mergedDockTabs.some((x) => x.id === t.id)) mergedDockTabs.push(t);
        }
        const mergedDockPanel = {
          ...existingDock,
          tabs: mergedDockTabs,
          tabHistory: [...new Set([...existingDock.tabHistory, ...incomingDock.tabHistory])].filter(
            (id) => mergedDockTabs.some((t) => t.id === id),
          ),
          activeTabId: null as string | null,
        };
        // Focus the switched-to project's own dock tab (not another project's).
        mergedDockPanel.activeTabId = pickDockActiveTab(mergedDockPanel, projectName);
        const mergedPanels = { ...panels, ...migratedPanels, [DOCK_PANEL_ID]: mergedDockPanel };
        newProjectGrids[projectName] = migratedGrid;
        newProjectFocused[projectName] = migratedFocused;
        const restoredDock = collapseRestoredDockOnMobile(
          loaded.dock ?? restoreDockForProject(projectName, newProjectDock),
          get().isMobile(),
        );
        set({
          currentProject: projectName,
          panels: mergedPanels,
          grid: migratedGrid,
          focusedPanelId: migratedFocused,
          projectGrids: newProjectGrids,
          projectFocused: newProjectFocused,
          dock: restoredDock,
          projectDock: newProjectDock,
        });
        // Write the healed layout back so the repair sticks (and reaches the server
        // blob), instead of being redone on every load.
        if (healed) {
          savePanelLayout(projectName, {
            panels: migratedPanels,
            grid: migratedGrid,
            focusedPanelId: migratedFocused,
            dock: restoredDock,
            dockPanel: mergedDockPanel,
          });
        }
      } else {
        // Create empty layout — EmptyPanel will show quick-open buttons
        const p = createPanel();
        const newGrid = [[p.id]];

        // Merge into flat panels map; preserve existing __dock__ (keep-alive)
        const mergedPanels = { ...panels, [p.id]: p };
        newProjectGrids[projectName] = newGrid;
        newProjectFocused[projectName] = p.id;
        const restoredDock = restoreDockForProject(projectName, newProjectDock);
        savePanelLayout(projectName, {
          panels: { [p.id]: p },
          grid: newGrid,
          focusedPanelId: p.id,
          dock: restoredDock,
          dockPanel: panels[DOCK_PANEL_ID],
        });
        set({
          currentProject: projectName,
          panels: mergedPanels,
          grid: newGrid,
          focusedPanelId: p.id,
          projectGrids: newProjectGrids,
          projectFocused: newProjectFocused,
          dock: restoredDock,
          projectDock: newProjectDock,
        });
      }
    },

    reloadProject: (projectName) => {
      const { projectGrids, projectFocused, projectDock, panels } = get();
      // Clear in-memory cache so switchProject re-reads from localStorage
      const newGrids = { ...projectGrids };
      const newFocused = { ...projectFocused };
      const newProjectDock = { ...projectDock };
      delete newGrids[projectName];
      delete newFocused[projectName];
      // Clear per-project dock snapshot so it reloads from localStorage
      delete newProjectDock[projectName];

      // Remove old grid panels belonging to this project from flat map.
      // IMPORTANT: __dock__ is a shared panel — never delete it on reload,
      // because terminals from OTHER projects would lose their xterm buffer.
      // Instead, filter out only this project's dock tabs by projectId.
      const oldGrid = projectGrids[projectName];
      const oldPanelIds = oldGrid ? new Set(oldGrid.flat()) : new Set<string>();
      const cleanedPanels = { ...panels };
      for (const id of oldPanelIds) {
        // Never remove the shared dock panel during project reload
        if (id !== DOCK_PANEL_ID) delete cleanedPanels[id];
      }

      // Clear this project's dock tabs from __dock__ (filter by projectId)
      const dockPanel = cleanedPanels[DOCK_PANEL_ID];
      if (dockPanel) {
        const remainingTabs = dockPanel.tabs.filter((t) => t.projectId !== projectName);
        const remainingIds = new Set(remainingTabs.map((t) => t.id));
        cleanedPanels[DOCK_PANEL_ID] = {
          ...dockPanel,
          tabs: remainingTabs,
          tabHistory: dockPanel.tabHistory.filter((id) => remainingIds.has(id)),
          activeTabId: dockPanel.activeTabId && remainingIds.has(dockPanel.activeTabId)
            ? dockPanel.activeTabId
            : remainingTabs[remainingTabs.length - 1]?.id ?? null,
        };
      }

      // A window panel is off-grid, so the loop above never reaches it: a floating
      // window would keep showing a tab of a project that no longer exists.
      const stripped = stripProjectFromWindowPanels(cleanedPanels, projectName);

      set({
        projectGrids: newGrids,
        projectFocused: newFocused,
        projectDock: newProjectDock,
        panels: stripped.panels,
        currentProject: null,
      });
      saveWindowPanels(stripped.panels);
      for (const windowId of stripped.windowIdsToClose) useWindowStore.getState().close(windowId);
      // Re-trigger full load from localStorage
      get().switchProject(projectName);
    },

    setFocusedPanel: (panelId) => {
      // Focus drives where the next tab opens, so it must stay on a real, on-grid panel.
      if (isWindowPanelId(panelId)) return;
      if (get().panels[panelId]) set({ focusedPanelId: panelId });
    },

    openTab: (tabDef, panelId?) => {
      const mobile = get().isMobile();
      // On mobile, always open in first panel (tabs merged in mobile nav)
      const pid = mobile
        ? (get().grid[0]?.[0] ?? resolvePanel(panelId))
        : resolvePanel(panelId);
      const panel = get().panels[pid];
      if (!panel) return "";

      // Terminal: compute next available index if not provided
      if (tabDef.type === "terminal" && !tabDef.metadata?.terminalIndex) {
        const allTabs = Object.values(get().panels).flatMap((p) => p.tabs);
        const terminalNums = allTabs
          .filter((t) => t.type === "terminal")
          .map((t) => {
            const match = t.id.match(/^terminal:(\d+)/);
            return match ? parseInt(match[1]!, 10) : 0;
          });
        const nextIndex = terminalNums.length > 0 ? Math.max(...terminalNums) + 1 : 1;
        tabDef = { ...tabDef, metadata: { ...tabDef.metadata, terminalIndex: nextIndex } };
      }

      const baseId = deriveTabId(tabDef.type, tabDef.metadata);

      // Chat: focus an already-open session across ALL panels. A chat started as
      // "New Chat" keeps its random-minted id even after it acquires a sessionId
      // (chat-tab only rewrites metadata, not the tab id), so deriveTabId's
      // chat:{provider}/{sessionId} never matches the live tab. Match on the real
      // sessionId instead so re-opening from history focuses the tab, not a dupe.
      if (tabDef.type === "chat" && tabDef.metadata?.sessionId) {
        const sid = tabDef.metadata.sessionId;
        for (const p of Object.values(get().panels)) {
          const existing = p.tabs.find((t) => t.type === "chat" && t.metadata?.sessionId === sid);
          if (existing) {
            set((s) => ({
              focusedPanelId: focusAfterActivate(p.id),
              panels: {
                ...s.panels,
                [p.id]: { ...p, tabs: stampActive(p.tabs, existing.id), activeTabId: existing.id, tabHistory: pushHistory(p.tabHistory, existing.id) },
              },
            }));
            persist();
            return existing.id;
          }
        }
      }

      // Singleton check — focus existing across ALL panels
      if (SINGLETON_TYPES.has(tabDef.type)) {
        for (const p of Object.values(get().panels)) {
          const existing = p.tabs.find((t) => t.id === baseId);
          if (existing) {
            set((s) => ({
              focusedPanelId: focusAfterActivate(p.id),
              panels: {
                ...s.panels,
                [p.id]: {
                  ...p,
                  tabs: stampActive(p.tabs, existing.id),
                  activeTabId: existing.id,
                  tabHistory: pushHistory(p.tabHistory, existing.id),
                },
              },
            }));
            persist();
            return existing.id;
          }
        }
      }

      // Mobile: dedup across all panels (merged tab bar shows all tabs)
      if (mobile) {
        for (const gpid of get().grid.flat()) {
          const p = get().panels[gpid];
          if (!p) continue;
          const existing = p.tabs.find((t) => t.id === baseId || t.id.startsWith(`${baseId}@`));
          if (existing) {
            set((s) => ({
              focusedPanelId: p.id,
              panels: {
                ...s.panels,
                [p.id]: { ...p, tabs: stampActive(p.tabs, existing.id), activeTabId: existing.id, tabHistory: pushHistory(p.tabHistory, existing.id) },
              },
            }));
            persist();
            return existing.id;
          }
        }
      }

      // Non-singleton: dedup within SAME panel only
      const currentPanel = get().panels[pid]!;
      const existingInPanel = currentPanel.tabs.find((t) => t.id === baseId);
      if (existingInPanel) {
        set((s) => ({
          panels: {
            ...s.panels,
            [pid]: {
              ...currentPanel,
              tabs: stampActive(currentPanel.tabs, existingInPanel.id),
              activeTabId: existingInPanel.id,
              tabHistory: pushHistory(currentPanel.tabHistory, existingInPanel.id),
            },
          },
        }));
        persist();
        return existingInPanel.id;
      }

      // Check if same base ID exists in OTHER panels (split case)
      const existsElsewhere = Object.values(get().panels).some(
        (p) => p.id !== pid && p.tabs.some((t) => t.id === baseId),
      );
      const id = existsElsewhere ? `${baseId}@${pid}` : baseId;

      const tab: Tab = { ...tabDef, id, metadata: { ...tabDef.metadata, lastActiveAt: Date.now() } };
      set((s) => {
        const p = s.panels[pid]!;
        return {
          focusedPanelId: pid,
          panels: {
            ...s.panels,
            [pid]: {
              ...p,
              tabs: [...p.tabs, tab],
              activeTabId: id,
              tabHistory: pushHistory(p.tabHistory, id),
            },
          },
        };
      });
      persist();
      return id;
    },

    closeTab: (tabId, panelId?) => {
      const panel = panelId ? get().panels[panelId] : findPanel(tabId);
      if (!panel) return;
      const pid = panel.id;

      // Closing a terminal ends it, from a grid panel and from the dock alike.
      // Parking a live session is an explicit action ("Move to Dock" / redockTab),
      // never a side effect of close.
      // Clear persisted terminal session so reopening creates a fresh PTY.
      if (tabId.startsWith("terminal:")) {
        try { localStorage.removeItem(`ppm:terminal-session:${tabId}`); } catch { /* */ }
      }

      set((s) => {
        const p = s.panels[pid]!;
        const newTabs = p.tabs.filter((t) => t.id !== tabId);
        const newHistory = p.tabHistory.filter((h) => h !== tabId);
        let newActive = p.activeTabId;
        if (p.activeTabId === tabId) {
          const prevId = newHistory.length > 0 ? newHistory[newHistory.length - 1] : null;
          newActive = prevId && newTabs.some((t) => t.id === prevId)
            ? prevId
            : newTabs[newTabs.length - 1]?.id ?? null;
        }

        // Auto-close panel if empty and not the last one in current grid.
        // Guard: never delete __dock__ — it lives outside `grid` (gridRemovePanel is a
        // no-op for it) so the map-delete would destroy the reserved dock panel, and a
        // later redock (moveTab → __dock__) would silently no-op (to === undefined),
        // leaving the terminal stuck in the grid while an empty dock opens.
        // A window panel is exempt from the "keep the last panel" rule: that rule
        // protects the grid from ending up with nothing to render, and a window panel
        // is not in the grid. Leaving it behind would strand an empty floating window.
        const gridPanelCount = s.grid.flat().length;
        const removable = isWindowPanelId(pid) || (gridPanelCount > 1 && pid !== DOCK_PANEL_ID);
        if (newTabs.length === 0 && removable) {
          const { [pid]: _, ...rest } = s.panels;
          const newGrid = gridRemovePanel(s.grid, pid);
          // Focus must land on a panel still in the grid — Object.keys(rest)
          // can return keep-alive panels from other projects (off-grid).
          const newFocused = s.focusedPanelId === pid
            ? (newGrid.flat()[0] ?? Object.keys(rest)[0]!)
            : s.focusedPanelId;
          return { panels: rest, grid: newGrid, focusedPanelId: newFocused };
        }

        return {
          panels: { ...s.panels, [pid]: { ...p, tabs: newTabs, activeTabId: newActive, tabHistory: newHistory } },
        };
      });
      persist();

      // Auto-close the dock when its last terminal is closed (no empty state).
      if (pid === DOCK_PANEL_ID && activeProjectDockTabCount(get) === 0) {
        get().setDockVisible(false);
      }

      // A window that lost its last tab closes with it — it can never show anything again.
      if (isWindowPanelId(pid)) syncWindowPanel(get, pid);
    },

    setActiveTab: (tabId, panelId?) => {
      const panel = panelId ? get().panels[panelId] : findPanel(tabId);
      if (!panel) return;
      const pid = panel.id;
      set((s) => {
        const p = s.panels[pid]!;
        return {
          focusedPanelId: focusAfterActivate(pid),
          panels: { ...s.panels, [pid]: { ...p, tabs: stampActive(p.tabs, tabId), activeTabId: tabId, tabHistory: pushHistory(p.tabHistory, tabId) } },
        };
      });
      persist();
    },

    updateTab: (tabId, updates) => {
      const panel = findPanel(tabId);
      if (!panel) return;
      set((s) => ({
        panels: {
          ...s.panels,
          [panel.id]: { ...panel, tabs: panel.tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t)) },
        },
      }));
      persist();
    },

    reorderTab: (tabId, panelId, newIndex) => {
      const panel = get().panels[panelId];
      if (!panel) return;
      const oldIndex = panel.tabs.findIndex((t) => t.id === tabId);
      if (oldIndex === -1 || oldIndex === newIndex) return;
      const newTabs = [...panel.tabs];
      const [moved] = newTabs.splice(oldIndex, 1);
      newTabs.splice(newIndex, 0, moved!);
      set((s) => ({ panels: { ...s.panels, [panelId]: { ...panel, tabs: newTabs } } }));
      persist();
    },

    moveTab: (tabId, fromPanelId, toPanelId, insertIndex?) => {
      if (fromPanelId === toPanelId) return;
      const from = get().panels[fromPanelId];
      const to = get().panels[toPanelId];
      if (!from || !to) return;

      const tab = from.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      const fromTabs = from.tabs.filter((t) => t.id !== tabId);
      const fromHistory = from.tabHistory.filter((h) => h !== tabId);
      const fromActive = from.activeTabId === tabId
        ? (fromHistory[fromHistory.length - 1] ?? fromTabs[fromTabs.length - 1]?.id ?? null)
        : from.activeTabId;

      const toTabs = [...to.tabs];
      if (insertIndex !== undefined) toTabs.splice(insertIndex, 0, tab);
      else toTabs.push(tab);

      set((s) => {
        const gridPanelCount = s.grid.flat().length;
        // Auto-close empty source panel if not last in current grid.
        // Guard: never attempt to remove __dock__ from the grid — it is intentionally
        // absent from grid and gridRemovePanel would be a no-op, but the panels-map
        // delete would destroy the dock panel entirely.
        // Same guard for a window panel: its lifetime belongs to the floating window,
        // and window-panel-actions is the single writer that deletes it (together with
        // closing the window). A silent delete here would strand an open, empty window.
        const offGridSource = fromPanelId === DOCK_PANEL_ID || isWindowPanelId(fromPanelId);
        if (fromTabs.length === 0 && gridPanelCount > 1 && !offGridSource) {
          const { [fromPanelId]: _, ...rest } = s.panels;
          return {
            panels: {
              ...rest,
              [toPanelId]: { ...to, tabs: toTabs, activeTabId: tabId, tabHistory: pushHistory(to.tabHistory, tabId) },
            },
            grid: gridRemovePanel(s.grid, fromPanelId),
            focusedPanelId: toPanelId,
          };
        }

        return {
          focusedPanelId: toPanelId,
          panels: {
            ...s.panels,
            [fromPanelId]: { ...from, tabs: fromTabs, activeTabId: fromActive, tabHistory: fromHistory },
            [toPanelId]: { ...to, tabs: toTabs, activeTabId: tabId, tabHistory: pushHistory(to.tabHistory, tabId) },
          },
        };
      });
      persist();
    },

    splitPanel: (direction, tabId, sourcePanelId, targetPanelId?) => {
      const { grid, panels } = get();
      const mobile = get().isMobile();
      const source = panels[sourcePanelId];
      if (!source) return false;

      const tab = source.tabs.find((t) => t.id === tabId);
      if (!tab) return false;

      // Use target panel's position for grid insertion (where the drop happened)
      const positionPanelId = targetPanelId ?? sourcePanelId;
      const pos = findPanelPosition(grid, positionPanelId);
      if (!pos) return false;

      // Check constraints — grid is row-major: grid[row][col]
      const isHorizontal = direction === "left" || direction === "right";
      const isVertical = direction === "up" || direction === "down";
      if (isHorizontal && (grid[pos.row]?.length ?? 0) >= maxColumns(mobile)) return false;
      if (isVertical && grid.length >= MAX_ROWS) return false;

      const newPanel = createPanel([tab], tab.id);
      newPanel.tabHistory = [tab.id];

      // Remove tab from source
      const srcTabs = source.tabs.filter((t) => t.id !== tabId);
      const srcHistory = source.tabHistory.filter((h) => h !== tabId);
      const srcActive = source.activeTabId === tabId
        ? (srcHistory[srcHistory.length - 1] ?? srcTabs[srcTabs.length - 1]?.id ?? null)
        : source.activeTabId;

      let newGrid: string[][];
      if (isHorizontal) {
        // Add column within the same row
        newGrid = grid.map((row, r) => {
          if (r !== pos.row) return row;
          const newRow = [...row];
          const insertCol = direction === "right" ? pos.col + 1 : pos.col;
          newRow.splice(insertCol, 0, newPanel.id);
          return newRow;
        });
      } else {
        // Add new row to the grid
        newGrid = [...grid];
        const insertRow = direction === "down" ? pos.row + 1 : pos.row;
        newGrid.splice(insertRow, 0, [newPanel.id]);
      }

      set((s) => {
        const gridPanelCount = s.grid.flat().length;
        let updatedPanels = {
          ...s.panels,
          [newPanel.id]: newPanel,
        };

        // If source is now empty and not last panel in grid, remove it
        if (srcTabs.length === 0 && gridPanelCount > 1) {
          const { [sourcePanelId]: _, ...rest } = updatedPanels;
          updatedPanels = rest;
          newGrid = gridRemovePanel(newGrid, sourcePanelId);
        } else {
          updatedPanels[sourcePanelId] = { ...source, tabs: srcTabs, activeTabId: srcActive, tabHistory: srcHistory };
        }

        return { panels: updatedPanels, grid: newGrid, focusedPanelId: newPanel.id };
      });
      persist();
      return true;
    },

    closePanel: (panelId) => {
      const { panels, grid } = get();
      if (grid.flat().length <= 1) return;

      const panel = panels[panelId];
      if (!panel) return;

      // Find neighbor to merge tabs into
      const pos = findPanelPosition(grid, panelId);
      const allIds = grid.flat();
      const idx = allIds.indexOf(panelId);
      const neighborId = idx > 0 ? allIds[idx - 1]! : allIds[1]!;
      const neighbor = panels[neighborId];
      if (!neighbor) return;

      set((s) => {
        const { [panelId]: _, ...rest } = s.panels;
        const mergedTabs = [...neighbor.tabs, ...panel.tabs];
        const mergedActive = neighbor.activeTabId ?? panel.activeTabId;
        return {
          panels: {
            ...rest,
            [neighborId]: { ...neighbor, tabs: mergedTabs, activeTabId: mergedActive, tabHistory: [...neighbor.tabHistory, ...panel.tabHistory] },
          },
          grid: gridRemovePanel(s.grid, panelId),
          focusedPanelId: neighborId,
        };
      });
      persist();
    },

    getPanelForTab: (tabId) => findPanel(tabId),

    isMobile: () => typeof window !== "undefined" && window.innerWidth < 768,
  };
});
