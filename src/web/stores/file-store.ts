import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import type { FileEntry, FileDirEntry } from "../../types/project";
import { entriesToNodes, mergeChildren } from "./file-tree-merge-helpers";
import { schedulePrefetch, cancelPrefetch } from "./file-tree-prefetch";
import { visibleNodesOf } from "@/components/explorer/flatten-visible-tree";

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

/** State for inline create/rename in the file tree */
export interface InlineAction {
  type: "new-file" | "new-folder" | "rename";
  /** Parent directory path (for new-file/new-folder) or parent of the renamed file */
  parentPath: string;
  /** Existing node being renamed (only for type=rename) */
  existingNode?: FileNode;
}

/**
 * Clipboard state for cut/copy/paste, shared by the project tree and the file explorer
 * windows.
 *
 * Paths are absolute. The two surfaces address files differently — the tree uses
 * project-relative paths, the explorer host-absolute ones — and a clipboard that spoke
 * either dialect could not be pasted across. Absolute is the only representation both can
 * always resolve. `origin` lets the tree recognise its own entries and keep using the
 * project-scoped routes for a purely internal paste.
 */
export interface ClipboardState {
  paths: string[];
  operation: "cut" | "copy";
  origin?: { projectName: string; root: string };
}

/**
 * Absolute host path for a project-relative path.
 *
 * The project API always returns relative segments joined with "/", but the composed
 * result must use the *host's* separator — a hardcoded "/" on a Windows root produced a
 * mixed-separator path (`C:\Users\PC\ppm/src/a.ts`) that neither matched an explorer
 * window's own absolute paths (cut-row highlight) nor split correctly under
 * `lastIndexOf(sep)` (source-directory derivation for cross-window refresh). The
 * separator is read straight off `root` — a Windows root always contains at least one
 * backslash — rather than threading host-info through every caller.
 */
export function absoluteProjectPath(root: string, relative: string): string {
  if (!relative) return root;
  const sep = root.includes("\\") ? "\\" : "/";
  const relativeNative = sep === "\\" ? relative.replace(/\//g, "\\") : relative;
  return root.endsWith(sep) ? `${root}${relativeNative}` : `${root}${sep}${relativeNative}`;
}

/** Project-relative path for an absolute one, or null when it lies outside the project. */
export function relativeProjectPath(root: string, absolute: string): string | null {
  const normalise = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalise(root);
  const target = normalise(absolute);
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
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
  inlineAction: InlineAction | null;
  clipboard: ClipboardState | null;
  focusedPath: string | null;

  setInlineAction(action: InlineAction | null): void;
  clearInlineAction(): void;
  setClipboard(clipboard: ClipboardState | null): void;
  setFocusedPath(path: string | null): void;
  loadRoot(projectName: string): Promise<void>;
  loadChildren(projectName: string, folderPath: string, opts?: { prefetch?: boolean }): Promise<void>;
  /** Load many folders in one request (expanded-state restore, deep expand) */
  loadPathsBatch(projectName: string, paths: string[]): Promise<void>;
  loadIndex(projectName: string): Promise<void>;
  invalidateIndex(): void;
  invalidateFolder(projectName: string, folderPath: string): Promise<void>;
  toggleExpand(projectName: string, path: string): void;
  setExpanded(path: string, expanded: boolean): void;
  collapseAll(): void;
  toggleFileSelect(path: string): void;
  setSelectedFiles(paths: string[]): void;
  clearSelection(): void;
  reset(): void;
  /** @deprecated Use loadRoot instead */
  fetchTree(projectName: string): Promise<void>;
}

/** Locate a node in the lazy tree by its project-relative path */
function findNodeByPath(tree: FileNode[], path: string): FileNode | undefined {
  let nodes = tree;
  for (;;) {
    const node = nodes.find((n) => n.path === path || path.startsWith(`${n.path}/`));
    if (!node) return undefined;
    if (node.path === path) return node;
    nodes = node.children ?? [];
  }
}

/** Enqueue idle prefetch of the given nodes' children (dirs only, skips ignored) */
function queuePrefetchFor(
  get: () => FileStore,
  projectName: string,
  children: FileNode[],
): void {
  schedulePrefetch(
    children,
    (path) => get().loadedPaths.has(path) || get().inflight.has(path),
    (path) => get().loadChildren(projectName, path, { prefetch: true }),
  );
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
  inlineAction: null,
  clipboard: null,
  focusedPath: null,

  setInlineAction: (action) => set({ inlineAction: action }),
  clearInlineAction: () => set({ inlineAction: null }),
  setClipboard: (clipboard) => set({ clipboard }),
  setFocusedPath: (path) => set({ focusedPath: path }),

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
      queuePrefetchFor(get, projectName, rootNodes);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load files",
        loading: false,
      });
    }
  },

  loadChildren: async (projectName: string, folderPath: string, opts?: { prefetch?: boolean }) => {
    const state = get();

    // Idempotent guard — skip if already loaded
    if (state.loadedPaths.has(folderPath)) return;
    // Prefetch never preempts an in-flight user-initiated request
    if (opts?.prefetch && state.inflight.has(folderPath)) return;

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
      // One level ahead only: prefetched loads don't cascade further
      if (!opts?.prefetch) queuePrefetchFor(get, projectName, children);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      // Remove from inflight on error
      const newInflight = new Map(get().inflight);
      newInflight.delete(folderPath);
      set({ inflight: newInflight });
    }
  },

  loadPathsBatch: async (projectName: string, paths: string[]) => {
    const state = get();
    const toLoad = [...new Set(paths)].filter((p) => !state.loadedPaths.has(p));
    if (toLoad.length === 0) return;
    if (state.tree.length === 0) set({ loading: true, error: null });
    try {
      const results = await api.post<{ path: string; entries?: FileDirEntry[]; error?: string }[]>(
        `${projectUrl(projectName)}/files/list-batch`,
        { paths: toLoad },
      );
      const current = get();
      let newTree = current.tree;
      const newLoaded = new Set(current.loadedPaths);
      const newExpanded = new Set(current.expandedPaths);
      // Parents before children so mergeChildren always finds its target node
      const ordered = [...results].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
      for (const r of ordered) {
        if (r.error != null || !r.entries) {
          // Stale persisted path (deleted folder) — drop from expanded state
          newExpanded.delete(r.path);
          continue;
        }
        const children = entriesToNodes(r.entries, r.path);
        newTree = r.path === "" ? children : mergeChildren(newTree, r.path, children);
        newLoaded.add(r.path);
      }
      set({ tree: newTree, loadedPaths: newLoaded, expandedPaths: newExpanded, loading: false });
      // Stay one level ahead of the restored view
      const rootChildren = newTree;
      queuePrefetchFor(get, projectName, rootChildren);
    } catch (err) {
      set({
        error: get().tree.length === 0 ? (err instanceof Error ? err.message : "Failed to load files") : null,
        loading: false,
      });
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
      } else {
        // Already loaded (e.g. by prefetch) — stay one level ahead of the user
        const node = findNodeByPath(get().tree, path);
        if (node?.children) queuePrefetchFor(get, projectName, node.children);
      }
    }
  },

  setExpanded: (path: string, expanded: boolean) => {
    const paths = new Set(get().expandedPaths);
    if (expanded) paths.add(path);
    else paths.delete(path);
    set({ expandedPaths: paths });
  },

  collapseAll: () => {
    set({ expandedPaths: new Set<string>() });
  },

  toggleFileSelect: (path: string) => {
    const current = get().selectedFiles;
    const idx = current.indexOf(path);
    if (idx >= 0) {
      set({ selectedFiles: current.filter((p) => p !== path) });
    } else {
      set({ selectedFiles: [...current, path] });
    }
  },

  setSelectedFiles: (paths) => set({ selectedFiles: paths }),

  clearSelection: () => set({ selectedFiles: [] }),

  reset: () => {
    cancelPrefetch();
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
      inlineAction: null,
      clipboard: null,
      focusedPath: null,
    });
  },

  /** @deprecated Alias for loadRoot — kept for callers in tab-bar and mobile-nav */
  fetchTree: async (projectName: string) => {
    await get().loadRoot(projectName);
    get().loadIndex(projectName);
  },
}));

// --- Expanded-state persistence (per project, localStorage) ---

const EXPANDED_KEY_PREFIX = "ppm-explorer-expanded:";

export function loadPersistedExpanded(projectName: string): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY_PREFIX + projectName);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function savePersistedExpanded(projectName: string, expandedPaths: Set<string>): void {
  try {
    // Root ("") is always expanded — no need to persist it
    const paths = [...expandedPaths].filter((p) => p !== "").slice(0, 50);
    localStorage.setItem(EXPANDED_KEY_PREFIX + projectName, JSON.stringify(paths));
  } catch { /* quota/unavailable — skip */ }
}

/** Compute flat visible path list from current tree state (for range selection) */
export function getVisiblePaths(): string[] {
  const { tree, expandedPaths } = useFileStore.getState();
  return visibleNodesOf(tree, expandedPaths).map((n) => n.path);
}
