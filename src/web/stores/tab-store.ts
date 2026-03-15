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
  /** Stack of recently active tab IDs (most recent last) */
  tabHistory: string[];
  currentProject: string | null;
  switchProject: (projectName: string) => void;
  openTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Omit<Tab, "id">>) => void;
}

/** Push a tab ID to the history stack, deduplicating (move to top if exists) */
function pushHistory(history: string[], id: string): string[] {
  const filtered = history.filter((h) => h !== id);
  filtered.push(id);
  // Cap at 50 entries to prevent unbounded growth
  if (filtered.length > 50) filtered.shift();
  return filtered;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const useTabStore = create<TabStore>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  tabHistory: [],
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
      set({ currentProject: projectName, ...newState, tabHistory: [defaultId] });
    } else {
      set({
        currentProject: projectName,
        tabs: loaded.tabs,
        activeTabId: loaded.activeTabId,
        tabHistory: loaded.activeTabId ? [loaded.activeTabId] : [],
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
        const history = pushHistory(get().tabHistory, existing.id);
        set({ activeTabId: existing.id, tabHistory: history });
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
      const history = pushHistory(s.tabHistory, id);
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: newTabs, activeTabId: id });
      }
      return { tabs: newTabs, activeTabId: id, tabHistory: history };
    });
    return id;
  },

  closeTab: (id) => {
    set((s) => {
      const newTabs = s.tabs.filter((t) => t.id !== id);
      // Remove closed tab from history
      const newHistory = s.tabHistory.filter((h) => h !== id);
      let newActive = s.activeTabId;
      if (s.activeTabId === id) {
        // Go back to the most recently active tab that still exists
        const prevId = newHistory.length > 0 ? newHistory[newHistory.length - 1] : null;
        newActive = prevId && newTabs.some((t) => t.id === prevId)
          ? prevId
          : newTabs[newTabs.length - 1]?.id ?? null;
      }
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: newTabs, activeTabId: newActive });
      }
      return { tabs: newTabs, activeTabId: newActive, tabHistory: newHistory };
    });
  },

  setActiveTab: (id) => {
    set((s) => {
      const history = pushHistory(s.tabHistory, id);
      if (s.currentProject) {
        saveTabs(s.currentProject, { tabs: s.tabs, activeTabId: id });
      }
      return { activeTabId: id, tabHistory: history };
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
