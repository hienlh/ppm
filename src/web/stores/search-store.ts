/**
 * The Search panel's state, one entry per project, kept outside the component so switching
 * sidebar panels, closing the mobile drawer or switching projects never loses a query, its
 * options or its results (6.5, 6.6).
 *
 * Two things are device-local and survive a reload: View as Tree/List (4.6, one choice for every
 * project) and each project's last `HISTORY_LIMIT` queries (6.3). localStorage is read lazily
 * and every access is guarded, since a blocked or full storage must not break searching.
 *
 * Requests are the client's job (`src/web/lib/search/search-client.ts`); this file holds no I/O
 * besides localStorage.
 */
import { create } from "zustand";
import type { SearchResponse } from "../../services/content-search/search-options";

export type SearchViewMode = "list" | "tree";
/** `searching` is set as soon as a search is scheduled, so a list on screen is known stale. */
export type SearchStatus = "idle" | "searching" | "done" | "error";
export interface SearchErrorInfo {
  message: string;
  /** HTTP status; 0 when the request never reached the server. */
  status: number;
}

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** "Files to include", comma-separated globs as typed. */
  include: string;
  /** "Files to exclude", comma-separated globs as typed. */
  exclude: string;
  /** "Use Exclude Settings and Ignore Files". */
  useIgnore: boolean;
  replace: string;
  preserveCase: boolean;
  showReplace: boolean;
  /** The ··· details (include/exclude) are open. */
  showDetails: boolean;
  response: SearchResponse | null;
  /** `matchKey`s and file paths dismissed from the list. Replace the Set, never mutate it. */
  dismissed: Set<string>;
  /** File and folder paths collapsed in the list. Replace the Set, never mutate it. */
  collapsed: Set<string>;
  focusedRow: string | null;
  status: SearchStatus;
  error: SearchErrorInfo | null;
  /** Position while stepping through the history; -1 when not stepping. */
  historyIndex: number;
}

export const HISTORY_LIMIT = 20;
export const VIEW_MODE_KEY = "ppm.search.viewMode";
export function historyKey(project: string): string {
  return `ppm.search.history.${project}`;
}

export function defaultSearchState(): SearchState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    include: "",
    exclude: "",
    useIgnore: true,
    replace: "",
    preserveCase: false,
    showReplace: false,
    showDetails: false,
    response: null,
    dismissed: new Set(),
    collapsed: new Set(),
    focusedRow: null,
    status: "idle",
    error: null,
    historyIndex: -1,
  };
}

/** What a project nobody has searched yet shows. One object, so selectors stay stable. */
const UNSEARCHED: SearchState = defaultSearchState();

export function readStoredViewMode(): SearchViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

export function readStoredHistory(project: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey(project)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === "string").slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked or out of quota: the value still applies for this page.
  }
}

interface SearchStore {
  /** projectName → its search. Read it through `getSearchState` or `projects[name] ?? …`. */
  projects: Record<string, SearchState>;
  /** projectName → its queries, newest first; filled from localStorage on first use. */
  history: Record<string, string[]>;
  viewMode: SearchViewMode;
  /** Merge `patch` into a project's state. Changing `query` ends a history walk. */
  update: (project: string, patch: Partial<SearchState>) => void;
  /** Clear Search Results: empty the query and the list, keep options and filters. */
  clear: (project: string) => void;
  setViewMode: (mode: SearchViewMode) => void;
  addToHistory: (project: string, query: string) => void;
  historyOf: (project: string) => string[];
  /** Alt+Up ("older") / Alt+Down ("newer"): put the next history entry in the field. */
  stepHistory: (project: string, direction: "older" | "newer") => void;
}

export const useSearchStore = create<SearchStore>((set, get) => {
  const stateOf = (project: string) => get().projects[project] ?? defaultSearchState();
  const put = (project: string, next: SearchState) =>
    set((s) => ({ projects: { ...s.projects, [project]: next } }));

  return {
    projects: {},
    history: {},
    viewMode: readStoredViewMode(),

    update(project, patch) {
      const next = { ...stateOf(project), ...patch };
      if ("query" in patch && !("historyIndex" in patch)) next.historyIndex = -1;
      put(project, next);
    },

    clear(project) {
      put(project, {
        ...stateOf(project),
        query: "",
        response: null,
        dismissed: new Set(),
        collapsed: new Set(),
        focusedRow: null,
        status: "idle",
        error: null,
        historyIndex: -1,
      });
    },

    setViewMode(mode) {
      writeStorage(VIEW_MODE_KEY, mode);
      set({ viewMode: mode });
    },

    historyOf(project) {
      const known = get().history[project];
      if (known) return known;
      const loaded = readStoredHistory(project);
      set((s) => ({ history: { ...s.history, [project]: loaded } }));
      return loaded;
    },

    addToHistory(project, query) {
      if (!query.trim()) return;
      const list = [query, ...get().historyOf(project).filter((q) => q !== query)].slice(0, HISTORY_LIMIT);
      writeStorage(historyKey(project), JSON.stringify(list));
      set((s) => ({ history: { ...s.history, [project]: list } }));
    },

    stepHistory(project, direction) {
      const list = get().historyOf(project);
      const current = stateOf(project);
      let index: number;
      if (direction === "older") {
        if (list.length === 0) return;
        // The field usually already shows the newest entry (it was just searched): skip past it.
        index = current.historyIndex === -1 ? (list[0] === current.query ? 1 : 0) : current.historyIndex + 1;
        index = Math.min(index, list.length - 1);
      } else {
        if (current.historyIndex === -1) return;
        index = current.historyIndex - 1;
      }
      put(project, { ...current, query: index === -1 ? "" : list[index]!, historyIndex: index });
    },
  };
});

/** A project's state, or the defaults (one shared object) when it has never been searched. */
export function getSearchState(project: string): SearchState {
  return useSearchStore.getState().projects[project] ?? UNSEARCHED;
}
