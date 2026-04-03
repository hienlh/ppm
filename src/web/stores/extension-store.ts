import { create } from "zustand";
import type { ExtensionContributes, ContributedCommand } from "../../types/extension.ts";

// --- UI types for extension components ---

export interface StatusBarItemUI {
  id: string;
  text: string;
  tooltip?: string;
  command?: string;
  alignment: "left" | "right";
  priority: number;
  extensionId?: string;
}

export interface TreeItemAction {
  icon: "refresh" | "edit" | "trash" | "plus" | "search";
  tooltip: string;
  command: string;
  commandArgs?: unknown[];
}

export interface TreeItemUI {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  color?: string;
  badge?: string;
  actions?: TreeItemAction[];
  collapsibleState: "none" | "collapsed" | "expanded";
  command?: string;
  commandArgs?: unknown[];
  children?: TreeItemUI[];
  contextValue?: string;
}

export interface WebviewPanelUI {
  id: string;
  extensionId: string;
  viewType: string;
  title: string;
  html: string;
}

export interface QuickPickState {
  items: QuickPickItemUI[];
  options: { placeholder?: string; canPickMany?: boolean };
  resolve: (selected: QuickPickItemUI[] | undefined) => void;
}

export interface QuickPickItemUI {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

export interface InputBoxState {
  options: { prompt?: string; value?: string; placeholder?: string; password?: boolean };
  resolve: (value: string | undefined) => void;
}

// --- Store ---

interface ExtensionStore {
  // Status bar
  statusBarItems: StatusBarItemUI[];
  addStatusBarItem: (item: StatusBarItemUI) => void;
  removeStatusBarItem: (id: string) => void;
  updateStatusBarItem: (id: string, updates: Partial<StatusBarItemUI>) => void;

  // Tree views
  treeViews: Record<string, TreeItemUI[]>;
  updateTree: (viewId: string, items: TreeItemUI[]) => void;
  updateTreeChildren: (viewId: string, parentId: string, children: TreeItemUI[]) => void;
  removeTree: (viewId: string) => void;

  // Webview panels
  webviewPanels: Record<string, WebviewPanelUI>;
  addWebviewPanel: (panel: WebviewPanelUI) => void;
  removeWebviewPanel: (id: string) => void;
  updateWebviewPanel: (id: string, updates: Partial<WebviewPanelUI>) => void;

  // Contributions (fetched from API)
  contributions: ExtensionContributes | null;
  setContributions: (c: ExtensionContributes) => void;

  // QuickPick modal
  quickPick: QuickPickState | null;
  showQuickPick: (items: QuickPickItemUI[], options?: QuickPickState["options"]) => Promise<QuickPickItemUI[] | undefined>;
  resolveQuickPick: (selected: QuickPickItemUI[] | undefined) => void;

  // InputBox modal
  inputBox: InputBoxState | null;
  showInputBox: (options?: InputBoxState["options"]) => Promise<string | undefined>;
  resolveInputBox: (value: string | undefined) => void;

  // Cleanup
  clearExtension: (extensionId: string) => void;
}

export const useExtensionStore = create<ExtensionStore>((set, get) => ({
  // --- Status bar ---
  statusBarItems: [],
  addStatusBarItem: (item) => set((s) => ({
    statusBarItems: [...s.statusBarItems.filter((i) => i.id !== item.id), item],
  })),
  removeStatusBarItem: (id) => set((s) => ({
    statusBarItems: s.statusBarItems.filter((i) => i.id !== id),
  })),
  updateStatusBarItem: (id, updates) => set((s) => ({
    statusBarItems: s.statusBarItems.map((i) => i.id === id ? { ...i, ...updates } : i),
  })),

  // --- Tree views ---
  treeViews: {},
  updateTree: (viewId, items) => set((s) => ({
    treeViews: { ...s.treeViews, [viewId]: items },
  })),
  updateTreeChildren: (viewId, parentId, children) => set((s) => {
    const items = s.treeViews[viewId];
    if (!items) return s;
    const merge = (nodes: TreeItemUI[]): TreeItemUI[] =>
      nodes.map((n) => {
        if (n.id === parentId) return { ...n, children, collapsibleState: "expanded" as const };
        if (n.children) return { ...n, children: merge(n.children) };
        return n;
      });
    return { treeViews: { ...s.treeViews, [viewId]: merge(items) } };
  }),
  removeTree: (viewId) => set((s) => {
    const { [viewId]: _, ...rest } = s.treeViews;
    return { treeViews: rest };
  }),

  // --- Webview panels ---
  webviewPanels: {},
  addWebviewPanel: (panel) => set((s) => ({
    webviewPanels: { ...s.webviewPanels, [panel.id]: panel },
  })),
  removeWebviewPanel: (id) => set((s) => {
    const { [id]: _, ...rest } = s.webviewPanels;
    return { webviewPanels: rest };
  }),
  updateWebviewPanel: (id, updates) => set((s) => {
    const existing = s.webviewPanels[id];
    if (!existing) return s;
    return { webviewPanels: { ...s.webviewPanels, [id]: { ...existing, ...updates } } };
  }),

  // --- Contributions ---
  contributions: null,
  setContributions: (c) => set({ contributions: c }),

  // --- QuickPick ---
  quickPick: null,
  showQuickPick: (items, options = {}) => {
    // Resolve any existing quickpick first (prevents promise leak)
    const existing = get().quickPick;
    if (existing) existing.resolve(undefined);
    return new Promise((resolve) => {
      set({ quickPick: { items, options, resolve } });
    });
  },
  resolveQuickPick: (selected) => {
    const qp = get().quickPick;
    if (qp) {
      qp.resolve(selected);
      set({ quickPick: null });
    }
  },

  // --- InputBox ---
  inputBox: null,
  showInputBox: (options = {}) => {
    // Resolve any existing inputbox first (prevents promise leak)
    const existing = get().inputBox;
    if (existing) existing.resolve(undefined);
    return new Promise((resolve) => {
      set({ inputBox: { options, resolve } });
    });
  },
  resolveInputBox: (value) => {
    const ib = get().inputBox;
    if (ib) {
      ib.resolve(value);
      set({ inputBox: null });
    }
  },

  // --- Cleanup ---
  clearExtension: (extensionId) => set((s) => {
    const webviewPanels = { ...s.webviewPanels };
    for (const [id, panel] of Object.entries(webviewPanels)) {
      if (panel.extensionId === extensionId) delete webviewPanels[id];
    }
    return {
      statusBarItems: s.statusBarItems.filter((i) => i.extensionId !== extensionId),
      webviewPanels,
    };
  }),
}));
