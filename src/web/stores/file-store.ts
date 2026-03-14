import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  size?: number;
  modified?: string;
}

interface FileStore {
  tree: FileNode[];
  loading: boolean;
  error: string | null;
  expandedPaths: Set<string>;
  selectedFiles: string[];
  fetchTree: (projectName: string) => Promise<void>;
  toggleExpand: (path: string) => void;
  setExpanded: (path: string, expanded: boolean) => void;
  toggleFileSelect: (path: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  tree: [],
  loading: false,
  error: null,
  expandedPaths: new Set<string>(),
  selectedFiles: [],

  fetchTree: async (projectName: string) => {
    set({ loading: true, error: null });
    try {
      const tree = await api.get<FileNode[]>(
        `${projectUrl(projectName)}/files/tree?depth=3`,
      );
      set({ tree, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load files",
        loading: false,
      });
    }
  },

  toggleExpand: (path: string) => {
    const expanded = new Set(get().expandedPaths);
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    set({ expandedPaths: expanded });
  },

  setExpanded: (path: string, expanded: boolean) => {
    const paths = new Set(get().expandedPaths);
    if (expanded) paths.add(path);
    else paths.delete(path);
    set({ expandedPaths: paths });
  },

  toggleFileSelect: (path: string) => {
    const current = get().selectedFiles;
    const idx = current.indexOf(path);
    if (idx >= 0) {
      set({ selectedFiles: current.filter((p) => p !== path) });
    } else {
      // Max 2 selected files
      const next = current.length >= 2 ? [current[1]!, path] : [...current, path];
      set({ selectedFiles: next });
    }
  },

  clearSelection: () => set({ selectedFiles: [] }),

  reset: () => set({ tree: [], expandedPaths: new Set(), error: null, selectedFiles: [] }),
}));
