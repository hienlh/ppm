import { create } from "zustand";
import { randomId } from "@/lib/utils";

export type TabType =
  | "projects"
  | "terminal"
  | "chat"
  | "editor"
  | "git-graph"
  | "git-status"
  | "git-diff"
  | "settings";

/** Tab types that can only have 1 instance per project */
const SINGLETON_TYPES = new Set<TabType>([
  "git-status",
  "git-graph",
  "settings",
  "projects",
]);

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  projectId: string | null;
  metadata?: Record<string, unknown>;
  closable: boolean;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------
const STORAGE_PREFIX = "ppm-tabs-";

function storageKey(projectName: string): string {
  return `${STORAGE_PREFIX}${projectName}`;
}

interface PersistedTabState {
  tabs: Tab[];
  activeTabId: string | null;
}

function loadTabs(projectName: string): PersistedTabState {
  try {
    const raw = localStorage.getItem(storageKey(projectName));
    if (raw) return JSON.parse(raw) as PersistedTabState;
  } catch {
    /* ignore */
  }
  return { tabs: [], activeTabId: null };
}

function saveTabs(projectName: string, state: PersistedTabState) {
  try {
    localStorage.setItem(storageKey(projectName), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Unique ID generator
// ---------------------------------------------------------------------------
function generateTabId(): string {
  return `tab-${randomId()}`;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------
interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  currentProject: string | null;
  switchProject: (projectName: string) => void;
  openTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Omit<Tab, "id">>) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const useTabStore = create<TabStore>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  currentProject: null,

  switchProject: (projectName: string) => {
    const { currentProject, tabs, activeTabId } = get();

    // Save current project's tabs first
    if (currentProject) {
      saveTabs(currentProject, { tabs, activeTabId });
    }

    // Load new project's tabs
    const loaded = loadTabs(projectName);

    // If no tabs, open default "Projects" tab
    if (loaded.tabs.length === 0) {
      const defaultId = generateTabId();
      const defaultTab: Tab = {
        id: defaultId,
        type: "projects",
        title: "Projects",
        projectId: null,
        closable: true,
      };
      const newState = { tabs: [defaultTab], activeTabId: defaultId };
      saveTabs(projectName, newState);
      set({ currentProject: projectName, ...newState });
    } else {
      set({
        currentProject: projectName,
        tabs: loaded.tabs,
        activeTabId: loaded.activeTabId,
      });
    }
  },

  openTab: (tabDef) => {
    const { currentProject } = get();

    // Singleton: only 1 instance per project (match type + projectId)
    if (SINGLETON_TYPES.has(tabDef.type)) {
      const existing = get().tabs.find(
        (t) => t.type === tabDef.type && t.projectId === tabDef.projectId,
      );
      if (existing) {
        set({ activeTabId: existing.id });
        if (currentProject) {
          saveTabs(currentProject, { tabs: get().tabs, activeTabId: existing.id });
        }
        return existing.id;
      }
    }

    const id = generateTabId();
    const tab: Tab = { ...tabDef, id };
    set((s) => {
      const newTabs = [...s.tabs, tab];
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: newTabs, activeTabId: id });
      }
      return { tabs: newTabs, activeTabId: id };
    });
    return id;
  },

  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const newTabs = s.tabs.filter((t) => t.id !== id);
      let newActive = s.activeTabId;
      if (s.activeTabId === id) {
        const nextIdx = Math.min(idx, newTabs.length - 1);
        newActive = newTabs[nextIdx]?.id ?? null;
      }
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: newTabs, activeTabId: newActive });
      }
      return { tabs: newTabs, activeTabId: newActive };
    });
  },

  setActiveTab: (id) => {
    set((s) => {
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: s.tabs, activeTabId: id });
      }
      return { activeTabId: id };
    });
  },

  updateTab: (id, updates) => {
    set((s) => {
      const newTabs = s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t));
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: newTabs, activeTabId: s.activeTabId });
      }
      return { tabs: newTabs };
    });
  },
}));
