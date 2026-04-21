import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import type { FileEntry, FileDirEntry } from "@/types/project";
import { entriesToNodes, mergeChildren } from "./file-tree-merge-helpers";

export type { FileEntry };

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  size?: number;
  modified?: string;
  /** True if path is matched by a .gitignore rule */
  ignored?: boolean;
}

interface FileStore {
  tree: FileNode[];
  fileIndex: FileEntry[];
  loading: boolean;
  error: string | null;
  expandedPaths: Set<string>;
  loadedPaths: Set<string>;
  /** In-flight AbortControllers keyed by folder path */
  inflight: Map<string, AbortController>;
  indexStatus: "idle" | "loading" | "ready" | "error";
  selectedFiles: string[];

  loadRoot(projectName: string): Promise<void>;
  loadChildren(projectName: string, folderPath: string): Promise<void>;
  loadIndex(projectName: string): Promise<void>;
  invalidateIndex(): void;
  invalidateFolder(projectName: string, folderPath: string): Promise<void>;
  toggleExpand(projectName: string, path: string): void;
  setExpanded(path: string, expanded: boolean): void;
  toggleFileSelect(path: string): void;
  clearSelection(): void;
  reset(): void;
  /** @deprecated Use loadRoot instead */
  fetchTree(projectName: string): Promise<void>;
}

export const useFileStore = create<FileStore>((set, get) => ({
  tree: [],
  fileIndex: [],
  loading: false,
  error: null,
  expandedPaths: new Set<string>(),
  loadedPaths: new Set<string>(),
  inflight: new Map<string, AbortController>(),
  indexStatus: "idle",
  selectedFiles: [],

  loadRoot: async (projectName: string) => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<FileDirEntry[]>(
        `${projectUrl(projectName)}/files/list?path=`,
      );
      const rootNodes = entriesToNodes(data, "");
      const loadedPaths = new Set(get().loadedPaths);
      loadedPaths.add(""); // root is loaded
      set({ tree: rootNodes, loading: false, loadedPaths });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load files",
        loading: false,
      });
    }
  },

  loadChildren: async (projectName: string, folderPath: string) => {
    const state = get();

    // Idempotent guard — skip if already loaded
    if (state.loadedPaths.has(folderPath)) return;

    // Abort any existing in-flight request for this path
    const existing = state.inflight.get(folderPath);
    if (existing) existing.abort();

    const controller = new AbortController();
    const inflight = new Map(state.inflight);
    inflight.set(folderPath, controller);
    set({ inflight });

    try {
      const encodedPath = encodeURIComponent(folderPath);
      const data = await api.get<FileDirEntry[]>(
        `${projectUrl(projectName)}/files/list?path=${encodedPath}`,
        { signal: controller.signal },
      );

      // Check if aborted between request start and completion (defense in depth)
      if (controller.signal.aborted) return;

      const children = entriesToNodes(data, folderPath);
      const currentState = get();
      const newTree = mergeChildren(currentState.tree, folderPath, children);
      const newLoadedPaths = new Set(currentState.loadedPaths);
      newLoadedPaths.add(folderPath);
      const newInflight = new Map(currentState.inflight);
      newInflight.delete(folderPath);
      set({ tree: newTree, loadedPaths: newLoadedPaths, inflight: newInflight });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      // Remove from inflight on error
      const newInflight = new Map(get().inflight);
      newInflight.delete(folderPath);
      set({ inflight: newInflight });
    }
  },

  loadIndex: async (projectName: string) => {
    set({ indexStatus: "loading" });
    try {
      const data = await api.get<FileEntry[]>(
        `${projectUrl(projectName)}/files/index`,
      );
      set({ fileIndex: data, indexStatus: "ready" });
    } catch {
      set({ indexStatus: "error" });
    }
  },

  invalidateIndex: () => {
    set({ indexStatus: "idle", fileIndex: [] });
  },

  invalidateFolder: async (projectName: string, folderPath: string) => {
    const state = get();

    // Only reload if this folder was previously loaded
    if (!state.loadedPaths.has(folderPath)) return;

    // Remove from loadedPaths to allow re-fetch
    const newLoadedPaths = new Set(state.loadedPaths);
    newLoadedPaths.delete(folderPath);
    set({ loadedPaths: newLoadedPaths });

    // Re-fetch if folder is currently expanded (or root)
    if (!folderPath || state.expandedPaths.has(folderPath)) {
      await get().loadChildren(projectName, folderPath);
    }
  },

  toggleExpand: (projectName: string, path: string) => {
    const state = get();
    const expanded = new Set(state.expandedPaths);
    if (expanded.has(path)) {
      expanded.delete(path);
      set({ expandedPaths: expanded });
    } else {
      expanded.add(path);
      set({ expandedPaths: expanded });
      // Lazy load children if not yet loaded
      if (!state.loadedPaths.has(path)) {
        get().loadChildren(projectName, path);
      }
    }
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

  reset: () => {
    // Abort all in-flight requests
    for (const ctrl of get().inflight.values()) ctrl.abort();
    set({
      tree: [],
      fileIndex: [],
      loading: false,
      error: null,
      expandedPaths: new Set(),
      loadedPaths: new Set(),
      inflight: new Map(),
      indexStatus: "idle",
      selectedFiles: [],
    });
  },

  /** @deprecated Alias for loadRoot — kept for callers in tab-bar and mobile-nav */
  fetchTree: async (projectName: string) => {
    await get().loadRoot(projectName);
    get().loadIndex(projectName);
  },
}));
