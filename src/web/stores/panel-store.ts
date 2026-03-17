import { create } from "zustand";
import { randomId } from "@/lib/utils";
import type { Tab, TabType } from "./tab-store";
import {
  type Panel,
  type PanelLayout,
  createPanel,
  gridAddColumn,
  gridAddRow,
  gridRemovePanel,
  findPanelPosition,
  maxColumns,
  MAX_ROWS,
  savePanelLayout,
  loadPanelLayout,
} from "./panel-utils";

/** Tab types that can only have 1 instance per project */
const SINGLETON_TYPES = new Set<TabType>(["git-graph", "settings"]);

/** Tab types removed in a prior version — filter them out when loading persisted state */
const OBSOLETE_TAB_TYPES = new Set(["projects", "git-status"]);

function generateTabId(): string {
  return `tab-${randomId()}`;
}

function pushHistory(history: string[], id: string): string[] {
  const filtered = history.filter((h) => h !== id);
  filtered.push(id);
  if (filtered.length > 50) filtered.shift();
  return filtered;
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

  // Project lifecycle
  switchProject: (projectName: string) => void;

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

  // Helpers
  getPanelForTab: (tabId: string) => Panel | undefined;
  isMobile: () => boolean;
}

function defaultLayout(): { panels: Record<string, Panel>; grid: string[][]; focusedPanelId: string } {
  const panel = createPanel();
  return { panels: { [panel.id]: panel }, grid: [[panel.id]], focusedPanelId: panel.id };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const usePanelStore = create<PanelStore>()((set, get) => {
  /** Save only the active project's panels to localStorage */
  function persist() {
    const { currentProject, panels, grid, focusedPanelId } = get();
    if (!currentProject) return;
    const panelIds = new Set(grid.flat());
    const projectPanels: Record<string, Panel> = {};
    for (const [id, p] of Object.entries(panels)) {
      if (panelIds.has(id)) projectPanels[id] = p;
    }
    savePanelLayout(currentProject, { panels: projectPanels, grid, focusedPanelId });
  }

  function findPanel(tabId: string): Panel | undefined {
    return Object.values(get().panels).find((p) => p.tabs.some((t) => t.id === tabId));
  }

  function resolvePanel(panelId?: string): string {
    return panelId ?? get().focusedPanelId;
  }

  return {
    ...defaultLayout(),
    currentProject: null,
    projectGrids: {},
    projectFocused: {},

    switchProject: (projectName) => {
      const { currentProject, panels, grid, focusedPanelId, projectGrids, projectFocused } = get();

      // No-op if same project
      if (currentProject === projectName) return;

      // Snapshot current project's state
      const newProjectGrids = { ...projectGrids };
      const newProjectFocused = { ...projectFocused };

      if (currentProject) {
        newProjectGrids[currentProject] = grid;
        newProjectFocused[currentProject] = focusedPanelId;
        // Persist to localStorage
        const panelIds = new Set(grid.flat());
        const currentPanels: Record<string, Panel> = {};
        for (const [id, p] of Object.entries(panels)) {
          if (panelIds.has(id)) currentPanels[id] = p;
        }
        savePanelLayout(currentProject, { panels: currentPanels, grid, focusedPanelId });
      }

      // Already in memory → restore from snapshot (no localStorage read)
      if (newProjectGrids[projectName]) {
        const restoredGrid = newProjectGrids[projectName]!;
        const restoredFocused = newProjectFocused[projectName] ?? restoredGrid[0]?.[0] ?? "";
        set({
          currentProject: projectName,
          grid: restoredGrid,
          focusedPanelId: restoredFocused,
          projectGrids: newProjectGrids,
          projectFocused: newProjectFocused,
        });
        return;
      }

      // Load from localStorage
      const loaded = loadPanelLayout(projectName);
      if (loaded && Object.keys(loaded.panels).length > 0) {
        // Migrate: remove obsolete tab types
        const migratedPanels: typeof loaded.panels = {};
        for (const [pid, panel] of Object.entries(loaded.panels)) {
          const filteredTabs = panel.tabs.filter((t) => !OBSOLETE_TAB_TYPES.has(t.type));
          const filteredHistory = panel.tabHistory.filter(
            (id) => filteredTabs.some((t) => t.id === id),
          );
          const activeTabId = panel.activeTabId && filteredTabs.some((t) => t.id === panel.activeTabId)
            ? panel.activeTabId
            : (filteredHistory[filteredHistory.length - 1] ?? filteredTabs[0]?.id ?? null);
          migratedPanels[pid] = { ...panel, tabs: filteredTabs, tabHistory: filteredHistory, activeTabId };
        }

        // Merge into flat panels map (keep-alive: old panels stay)
        const mergedPanels = { ...panels, ...migratedPanels };
        newProjectGrids[projectName] = loaded.grid;
        newProjectFocused[projectName] = loaded.focusedPanelId;
        set({
          currentProject: projectName,
          panels: mergedPanels,
          grid: loaded.grid,
          focusedPanelId: loaded.focusedPanelId,
          projectGrids: newProjectGrids,
          projectFocused: newProjectFocused,
        });
      } else {
        // Create default layout for new project
        const p = createPanel();
        const defaultTab: Tab = {
          id: generateTabId(), type: "chat", title: "AI Chat", projectId: projectName, closable: true,
          metadata: { projectName },
        };
        p.tabs = [defaultTab];
        p.activeTabId = defaultTab.id;
        p.tabHistory = [defaultTab.id];
        const newGrid = [[p.id]];

        // Merge into flat panels map
        const mergedPanels = { ...panels, [p.id]: p };
        newProjectGrids[projectName] = newGrid;
        newProjectFocused[projectName] = p.id;
        savePanelLayout(projectName, { panels: { [p.id]: p }, grid: newGrid, focusedPanelId: p.id });
        set({
          currentProject: projectName,
          panels: mergedPanels,
          grid: newGrid,
          focusedPanelId: p.id,
          projectGrids: newProjectGrids,
          projectFocused: newProjectFocused,
        });
      }
    },

    setFocusedPanel: (panelId) => {
      if (get().panels[panelId]) set({ focusedPanelId: panelId });
    },

    openTab: (tabDef, panelId?) => {
      const pid = resolvePanel(panelId);
      const panel = get().panels[pid];
      if (!panel) return "";

      // Singleton check across ALL panels
      if (SINGLETON_TYPES.has(tabDef.type)) {
        for (const p of Object.values(get().panels)) {
          const existing = p.tabs.find((t) => t.type === tabDef.type && t.projectId === tabDef.projectId);
          if (existing) {
            set((s) => ({
              focusedPanelId: p.id,
              panels: {
                ...s.panels,
                [p.id]: {
                  ...p,
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

      const id = generateTabId();
      const tab: Tab = { ...tabDef, id };
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

        // Auto-close panel if empty and not the last one
        const panelIds = Object.keys(s.panels);
        if (newTabs.length === 0 && panelIds.length > 1) {
          const { [pid]: _, ...rest } = s.panels;
          const newGrid = gridRemovePanel(s.grid, pid);
          const newFocused = s.focusedPanelId === pid ? Object.keys(rest)[0]! : s.focusedPanelId;
          return { panels: rest, grid: newGrid, focusedPanelId: newFocused };
        }

        return {
          panels: { ...s.panels, [pid]: { ...p, tabs: newTabs, activeTabId: newActive, tabHistory: newHistory } },
        };
      });
      persist();
    },

    setActiveTab: (tabId, panelId?) => {
      const panel = panelId ? get().panels[panelId] : findPanel(tabId);
      if (!panel) return;
      const pid = panel.id;
      set((s) => {
        const p = s.panels[pid]!;
        return {
          focusedPanelId: pid,
          panels: { ...s.panels, [pid]: { ...p, activeTabId: tabId, tabHistory: pushHistory(p.tabHistory, tabId) } },
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
        const panelIds = Object.keys(s.panels);
        // Auto-close empty source panel if not last
        if (fromTabs.length === 0 && panelIds.length > 1) {
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

      // Check constraints
      const isHorizontal = direction === "left" || direction === "right";
      const isVertical = direction === "up" || direction === "down";
      if (isHorizontal && grid.length >= maxColumns(mobile)) return false;
      if (isVertical && (grid[pos.col]?.length ?? 0) >= MAX_ROWS) return false;

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
        newGrid = [...grid];
        const insertCol = direction === "right" ? pos.col + 1 : pos.col;
        newGrid.splice(insertCol, 0, [newPanel.id]);
      } else {
        // up: insert before current row, down: insert after
        newGrid = grid.map((col, c) => {
          if (c !== pos.col) return col;
          const newCol = [...col];
          const insertRow = direction === "down" ? pos.row + 1 : pos.row;
          newCol.splice(insertRow, 0, newPanel.id);
          return newCol;
        });
      }

      set((s) => {
        const panelIds = Object.keys(s.panels);
        let updatedPanels = {
          ...s.panels,
          [newPanel.id]: newPanel,
        };

        // If source is now empty and not last panel, remove it
        if (srcTabs.length === 0 && panelIds.length > 1) {
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
      if (Object.keys(panels).length <= 1) return;

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
