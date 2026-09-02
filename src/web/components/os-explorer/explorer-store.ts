/**
 * Per-window explorer state, keyed by floating-window id.
 *
 * Each window browses independently (own path, history, selection, filter), so the state
 * cannot live in a single global slice. View preferences are the exception: sort, view
 * mode and the hidden-files toggle are user settings and are shared plus persisted.
 *
 * Windows also have to agree about the disk. After any mutation the acting window calls
 * `fsChanged(dir)` and every window currently showing that directory refetches, which is
 * what makes "cut here, paste there" look instantaneous in both frames.
 */

import { create } from "zustand";
import type { FsBreadcrumb, FsEntry } from "@/lib/fs-api";

export type SortKey = "name" | "size" | "modified" | "kind";
export type SortDir = "asc" | "desc";
export type ViewMode = "list" | "icons" | "columns";

export interface ExplorerError {
  message: string;
  code: string;
  hint?: string;
}

/** Inline editing state: renaming an existing entry, or naming a new one. */
export type InlineEdit =
  | { kind: "rename"; path: string; initial: string }
  | { kind: "new-file" | "new-folder"; initial: string };

export interface ExplorerSlice {
  path: string;
  /** Visited paths; `historyIndex` points at the current one. */
  history: string[];
  historyIndex: number;
  entries: FsEntry[];
  breadcrumbs: FsBreadcrumb[];
  parent: string | null;
  sep: string;
  truncated: boolean;
  loading: boolean;
  error: ExplorerError | null;
  selection: Set<string>;
  /** Range-selection anchor; shift-click extends from here. */
  anchor: string | null;
  filter: string;
  inlineEdit: InlineEdit | null;
}

export interface ExplorerViewPrefs {
  sort: { key: SortKey; dir: SortDir };
  viewMode: ViewMode;
  showHidden: boolean;
}

const VIEW_PREFS_KEY = "ppm-explorer-view";

const DEFAULT_PREFS: ExplorerViewPrefs = {
  sort: { key: "name", dir: "asc" },
  viewMode: "list",
  showHidden: false,
};

function loadPrefs(): ExplorerViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ExplorerViewPrefs>;
    return {
      sort: parsed.sort?.key ? parsed.sort : DEFAULT_PREFS.sort,
      viewMode: parsed.viewMode ?? DEFAULT_PREFS.viewMode,
      showHidden: parsed.showHidden ?? DEFAULT_PREFS.showHidden,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: ExplorerViewPrefs): void {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* quota or private mode — preferences simply do not persist */
  }
}

function emptySlice(path: string): ExplorerSlice {
  return {
    path,
    history: [path],
    historyIndex: 0,
    entries: [],
    breadcrumbs: [],
    parent: null,
    sep: "/",
    truncated: false,
    loading: true,
    error: null,
    selection: new Set(),
    anchor: null,
    filter: "",
    inlineEdit: null,
  };
}

interface ExplorerStore extends ExplorerViewPrefs {
  slices: Record<string, ExplorerSlice>;
  /** Create the slice for a window if it does not exist yet. */
  ensure(id: string, path: string): void;
  /** Drop a window's slice when it closes. */
  discard(id: string): void;
  patch(id: string, partial: Partial<ExplorerSlice>): void;
  setPrefs(partial: Partial<ExplorerViewPrefs>): void;
}

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  ...loadPrefs(),
  slices: {},

  ensure: (id, path) => {
    if (get().slices[id]) return;
    set((s) => ({ slices: { ...s.slices, [id]: emptySlice(path) } }));
  },

  discard: (id) => {
    set((s) => {
      if (!s.slices[id]) return s;
      const slices = { ...s.slices };
      delete slices[id];
      return { slices };
    });
  },

  patch: (id, partial) => {
    set((s) => {
      const current = s.slices[id];
      if (!current) return s;
      return { slices: { ...s.slices, [id]: { ...current, ...partial } } };
    });
  },

  setPrefs: (partial) => {
    set((s) => {
      const next: ExplorerViewPrefs = {
        sort: partial.sort ?? s.sort,
        viewMode: partial.viewMode ?? s.viewMode,
        showHidden: partial.showHidden ?? s.showHidden,
      };
      savePrefs(next);
      return next;
    });
  },
}));

/** Read a window's slice outside React (action modules, keyboard handlers). */
export function sliceOf(id: string): ExplorerSlice | undefined {
  return useExplorerStore.getState().slices[id];
}

// ── Cross-window refresh ───────────────────────────────────────────

type DirListener = (dir: string) => void;
const dirListeners = new Set<DirListener>();

/**
 * Announce that `dir`'s contents changed on disk. Every window showing that
 * directory — including the one that caused the change — refetches.
 */
export function fsChanged(...dirs: (string | null | undefined)[]): void {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const listener of dirListeners) listener(dir);
  }
}

export function onFsChanged(listener: DirListener): () => void {
  dirListeners.add(listener);
  return () => dirListeners.delete(listener);
}
