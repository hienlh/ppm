import { create } from "zustand";

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

interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  openTab(tab: Omit<Tab, "id">): string;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  updateTab(id: string, updates: Partial<Tab>): void;
}

let _nextId = 1;
function genId() {
  return `tab-${_nextId++}`;
}

function metaKey(tab: Omit<Tab, "id">): string {
  const meta = tab.metadata ?? {};
  return `${tab.type}::${meta.filePath ?? ""}::${meta.sessionId ?? ""}`;
}

const defaultProjectsTab: Tab = {
  id: genId(),
  type: "projects",
  title: "Projects",
  closable: false,
};

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [defaultProjectsTab],
  activeTabId: defaultProjectsTab.id,

  openTab(tab) {
    const existing = get().tabs.find(
      (t) => metaKey(t as Omit<Tab, "id">) === metaKey(tab),
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = genId();
    const newTab: Tab = { ...tab, id };
    set((s) => ({ tabs: [...s.tabs, newTab], activeTabId: id }));
    return id;
  },

  closeTab(id) {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const remaining = tabs.filter((t) => t.id !== id);
    let nextActive = activeTabId;
    if (activeTabId === id) {
      const prev = remaining[idx - 1] ?? remaining[0] ?? null;
      nextActive = prev?.id ?? null;
    }
    set({ tabs: remaining, activeTabId: nextActive });
  },

  setActiveTab(id) {
    set({ activeTabId: id });
  },

  updateTab(id, updates) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
  },
}));
