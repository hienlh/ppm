import { create } from "zustand";
import { usePanelStore } from "./panel-store";
import { getNextUntitledNumber } from "./panel-utils";

export type TabType =
  | "terminal"
  | "chat"
  | "editor"
  | "database"
  | "sqlite"
  | "postgres"
  | "git-graph"
  | "git-diff"
  | "settings"
  | "ports"
  | "extension-webview";

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  projectId: string | null;
  metadata?: Record<string, unknown>;
  closable: boolean;
}

// ---------------------------------------------------------------------------
// Facade store — delegates to panel-store, exposes focused panel's tabs
// ---------------------------------------------------------------------------
interface TabStore {
  /** Tabs of the focused panel */
  tabs: Tab[];
  /** Active tab in focused panel */
  activeTabId: string | null;
  tabHistory: string[];
  currentProject: string | null;
  switchProject: (projectName: string) => void;
  openTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Omit<Tab, "id">>) => void;
  openNewFile: () => string;
}

export const useTabStore = create<TabStore>()(() => ({
  tabs: [],
  activeTabId: null,
  tabHistory: [],
  currentProject: null,

  switchProject: (projectName: string) => {
    usePanelStore.getState().switchProject(projectName);
    syncFromPanelStore();
  },

  openTab: (tabDef) => {
    const id = usePanelStore.getState().openTab(tabDef);
    syncFromPanelStore();
    return id;
  },

  closeTab: (id) => {
    usePanelStore.getState().closeTab(id);
    syncFromPanelStore();
  },

  setActiveTab: (id) => {
    usePanelStore.getState().setActiveTab(id);
    syncFromPanelStore();
  },

  updateTab: (id, updates) => {
    usePanelStore.getState().updateTab(id, updates);
    syncFromPanelStore();
  },

  openNewFile: () => {
    const ps = usePanelStore.getState();
    const num = getNextUntitledNumber(ps.panels);
    const id = ps.openTab({
      type: "editor",
      title: `Untitled-${num}`,
      projectId: null,
      metadata: { isUntitled: true, untitledNumber: num },
      closable: true,
    });
    syncFromPanelStore();
    return id;
  },
}));

// ---------------------------------------------------------------------------
// Sync focused panel state → tab-store for backward compat
// ---------------------------------------------------------------------------
function syncFromPanelStore() {
  const ps = usePanelStore.getState();
  const focused = ps.panels[ps.focusedPanelId];
  useTabStore.setState({
    tabs: focused?.tabs ?? [],
    activeTabId: focused?.activeTabId ?? null,
    tabHistory: focused?.tabHistory ?? [],
    currentProject: ps.currentProject,
  });
}

// Subscribe to panel-store changes to keep tab-store in sync
usePanelStore.subscribe(() => syncFromPanelStore());
