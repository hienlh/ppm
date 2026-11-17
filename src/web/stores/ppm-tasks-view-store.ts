/**
 * How the Tasks sidebar section is looking at tasks on this device: one project or all of them,
 * the filter chips, the search text, and which projects the all-projects view hides. Kept per
 * device (localStorage, read defensively: a private window or a test has none) — like the other
 * device prefs, a phone and a desktop each keep their own view.
 */
import { create } from "zustand";
import type { BaseGroup } from "../../shared/ppm-tasks";

export type TaskScope = "project" | "all";

export interface TaskViewFilters {
  /** Status groups shown; empty means the default, every open group. */
  groups: BaseGroup[];
  types: string[];
  /** A member id (assignee or waiting on); `me` is the user. */
  person: string | null;
  tag: string | null;
  /** A declared select/date field to filter on (`key` = value). */
  field: { key: string; value: string } | null;
  /** Only the open tasks waiting on the user (the "Waiting on you" chip). */
  waitingOnMe?: boolean;
}

export const EMPTY_FILTERS: TaskViewFilters = { groups: [], types: [], person: null, tag: null, field: null, waitingOnMe: false };

interface TaskViewState {
  scope: TaskScope;
  filters: TaskViewFilters;
  query: string;
  searchOpen: boolean;
  /** Projects left out of the all-projects list (their chips are off). */
  hiddenProjects: string[];
  setScope(scope: TaskScope): void;
  setFilters(patch: Partial<TaskViewFilters>): void;
  clearFilters(): void;
  setQuery(query: string): void;
  setSearchOpen(open: boolean): void;
  toggleProject(project: string): void;
}

const KEY = "ppm:tasks-view";

function read(): Partial<Pick<TaskViewState, "scope" | "filters" | "hiddenProjects">> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    const scope = v.scope === "all" ? "all" : "project";
    const f = (v.filters ?? {}) as Partial<TaskViewFilters>;
    const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    return {
      scope,
      filters: {
        groups: strings(f.groups).filter((g): g is BaseGroup => ["not_started", "active", "waiting", "closed"].includes(g)),
        types: strings(f.types),
        person: typeof f.person === "string" ? f.person : null,
        tag: typeof f.tag === "string" ? f.tag : null,
        field: f.field && typeof f.field.key === "string" && typeof f.field.value === "string" ? { key: f.field.key, value: f.field.value } : null,
        waitingOnMe: f.waitingOnMe === true,
      },
      hiddenProjects: strings(v.hiddenProjects),
    };
  } catch {
    return {};
  }
}

function write(s: Pick<TaskViewState, "scope" | "filters" | "hiddenProjects">): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ scope: s.scope, filters: s.filters, hiddenProjects: s.hiddenProjects }));
  } catch { /* storage unavailable: the view just does not survive a reload */ }
}

export const useTaskViewStore = create<TaskViewState>()((set, get) => {
  const save = () => write(get());
  const saved = read();
  return {
    scope: saved.scope ?? "project",
    filters: saved.filters ?? EMPTY_FILTERS,
    query: "",
    searchOpen: false,
    hiddenProjects: saved.hiddenProjects ?? [],
    setScope: (scope) => { set({ scope }); save(); },
    setFilters: (patch) => { set((s) => ({ filters: { ...s.filters, ...patch } })); save(); },
    clearFilters: () => { set({ filters: EMPTY_FILTERS }); save(); },
    setQuery: (query) => set({ query }),
    setSearchOpen: (searchOpen) => set(searchOpen ? { searchOpen } : { searchOpen, query: "" }),
    toggleProject: (project) => {
      set((s) => ({ hiddenProjects: s.hiddenProjects.includes(project) ? s.hiddenProjects.filter((p) => p !== project) : [...s.hiddenProjects, project] }));
      save();
    },
  };
});
