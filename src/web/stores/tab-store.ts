import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TabType =
  | "projects"
  | "terminal"
  | "chat"
  | "editor"
  | "git-graph"
  | "git-status"
  | "git-diff"
  | "settings";

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  metadata?: Record<string, unknown>;
  closable: boolean;
}

/** Build a dedup key from type + metadata to prevent duplicate tabs */
function tabKey(type: TabType, metadata?: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) return type;
  const sorted = Object.keys(metadata)
    .sort()
    .map((k) => `${k}=${String(metadata[k])}`)
    .join("&");
  return `${type}:${sorted}`;
}

let nextId = 1;

interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  openTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Omit<Tab, "id">>) => void;
}

export const useTabStore = create<TabStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,

      openTab: (tabDef) => {
        // Terminal and chat tabs should allow duplicates (multiple instances)
        const allowDuplicate =
          tabDef.type === "terminal" || tabDef.type === "chat";

        if (!allowDuplicate) {
          const key = tabKey(tabDef.type, tabDef.metadata);
          const existing = get().tabs.find(
            (t) => tabKey(t.type, t.metadata) === key,
          );
          if (existing) {
            set({ activeTabId: existing.id });
            return existing.id;
          }
        }

        const id = `tab-${nextId++}`;
        const tab: Tab = { ...tabDef, id };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
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
          return { tabs: newTabs, activeTabId: newActive };
        });
      },

      setActiveTab: (id) => set({ activeTabId: id }),

      updateTab: (id, updates) => {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, ...updates } : t,
          ),
        }));
      },
    }),
    {
      name: "ppm-tabs",
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      onRehydrateStorage: () => (state) => {
        // Ensure nextId doesn't collide with restored tab IDs
        if (state?.tabs) {
          for (const tab of state.tabs) {
            const num = parseInt(tab.id.replace("tab-", ""), 10);
            if (!isNaN(num) && num >= nextId) nextId = num + 1;
          }
        }
      },
    },
  ),
);
