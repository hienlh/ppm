import { create } from "zustand";
import { api, getAuthToken } from "@/lib/api-client";
import { resizeImageToWebp } from "@/lib/resize-image";

export interface Project {
  name: string;
  path: string;
  color?: string;
  image?: string;
}

export interface ProjectInfo extends Project {
  branch?: string;
  status?: "clean" | "dirty";
}

// ---------------------------------------------------------------------------
// Recently-used tracking via localStorage
// ---------------------------------------------------------------------------
const RECENT_KEY = "ppm-recent-projects";
const RECENT_TIMES_KEY = "ppm-recent-times";
const CUSTOM_ORDER_KEY = "ppm-custom-order";

function loadRecentOrder(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecentOrder(order: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(order));
  } catch { /* ignore */ }
}

/** Map of project name → epoch ms it was last opened. Populated going forward. */
export function loadRecentTimes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(RECENT_TIMES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveRecentTimes(times: Record<string, number>) {
  try {
    localStorage.setItem(RECENT_TIMES_KEY, JSON.stringify(times));
  } catch { /* ignore */ }
}

/** Move project name to front of recent list + record last-opened timestamp.
 *  Writes localStorage (instant) + syncs to server (so other tunnels/devices see it). */
function touchRecent(name: string) {
  const order = loadRecentOrder().filter((n) => n !== name);
  order.unshift(name);
  saveRecentOrder(order);

  const times = loadRecentTimes();
  times[name] = Date.now();
  saveRecentTimes(times);

  // Merge the full map into the shared server-side UI prefs blob.
  api.put("/api/settings/ui-prefs", { recentOpen: times }).catch(() => { /* offline cache still set */ });
}

// ---------------------------------------------------------------------------
// Project list sort mode (persisted server-side + localStorage cache)
// ---------------------------------------------------------------------------
export type SortMode = "recent" | "priority" | "name";
const SORT_KEY = "ppm-project-sort";

function loadSortModeLS(): SortMode {
  const v = localStorage.getItem(SORT_KEY);
  return v === "recent" || v === "name" ? v : "priority";
}

/** Sort projects by recent usage (most recent first) */
export function sortByRecent(projects: ProjectInfo[]): ProjectInfo[] {
  const order = loadRecentOrder();
  const orderMap = new Map(order.map((name, i) => [name, i]));
  return [...projects].sort((a, b) => {
    const ai = orderMap.get(a.name) ?? Infinity;
    const bi = orderMap.get(b.name) ?? Infinity;
    return ai - bi;
  });
}

function loadCustomOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(CUSTOM_ORDER_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function saveCustomOrder(order: string[]) {
  try {
    localStorage.setItem(CUSTOM_ORDER_KEY, JSON.stringify(order));
  } catch { /* ignore */ }
}

/** Resolve display order: custom order if set, else preserve server order */
export function resolveOrder(projects: ProjectInfo[], customOrder: string[] | null): ProjectInfo[] {
  if (!customOrder) return [...projects];
  const orderMap = new Map(customOrder.map((name, i) => [name, i]));
  return [...projects].sort((a, b) => {
    const ai = orderMap.get(a.name) ?? Infinity;
    const bi = orderMap.get(b.name) ?? Infinity;
    return ai - bi;
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface ProjectStore {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  customOrder: string[] | null;
  projectSortMode: SortMode;
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  hydrateUiPrefs: () => Promise<void>;
  setProjectSortMode: (mode: SortMode) => void;
  setActiveProject: (project: ProjectInfo) => void;
  addProject: (path: string, name?: string) => Promise<ProjectInfo>;
  setProjectColor: (name: string, color: string | null) => Promise<void>;
  setProjectImage: (name: string, file: File) => Promise<void>;
  removeProjectImage: (name: string) => Promise<void>;
  moveProject: (name: string, direction: "up" | "down") => Promise<void>;
  reorderProjects: (newOrder: string[]) => Promise<void>;
  renameProject: (name: string, newName: string) => Promise<void>;
  deleteProject: (name: string) => Promise<void>;
}

/** Refresh the active-project reference from the freshly fetched list (by name)
 *  so avatar/color edits to the currently-active project render immediately
 *  (fetchProjects only replaces the `projects` array, not `activeProject`). */
function syncActiveProject(
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void,
  name: string,
): void {
  const active = get().activeProject;
  if (active?.name !== name) return;
  const fresh = get().projects.find((p) => p.name === name);
  if (fresh) set({ activeProject: fresh });
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeProject: null,
  customOrder: loadCustomOrder(),
  projectSortMode: loadSortModeLS(),
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await api.get<ProjectInfo[]>("/api/projects");
      set({ projects, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch projects",
        loading: false,
      });
    }
  },

  /** Load server-persisted UI prefs (sort mode + recent open-times) into the
   *  local cache so a new tunnel/device reflects the last choice. Call once at startup. */
  hydrateUiPrefs: async () => {
    try {
      // Shared server-side UI prefs blob (also holds sidebar/editor prefs — ignore those here).
      const prefs = await api.get<{ projectSortMode?: string; recentOpen?: Record<string, number> }>(
        "/api/settings/ui-prefs",
      );
      if (prefs.recentOpen && Object.keys(prefs.recentOpen).length > 0) {
        saveRecentTimes(prefs.recentOpen);
        // Rebuild the recent ORDER list from server timestamps (newest first)
        // so sortByRecent works on a fresh browser with no local order.
        const order = Object.entries(prefs.recentOpen)
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        saveRecentOrder(order);
      }
      if (prefs.projectSortMode === "recent" || prefs.projectSortMode === "priority" || prefs.projectSortMode === "name") {
        try { localStorage.setItem(SORT_KEY, prefs.projectSortMode); } catch { /* ignore */ }
        set({ projectSortMode: prefs.projectSortMode });
      }
    } catch { /* server unreachable — keep local cache */ }
  },

  setProjectSortMode: (mode) => {
    try { localStorage.setItem(SORT_KEY, mode); } catch { /* ignore */ }
    set({ projectSortMode: mode });
    api.put("/api/settings/ui-prefs", { projectSortMode: mode }).catch(() => { /* offline cache still set */ });
  },

  setActiveProject: (project) => {
    touchRecent(project.name);
    set({ activeProject: project });
  },

  addProject: async (path, name) => {
    const project = await api.post<ProjectInfo>("/api/projects", { path, name });
    await get().fetchProjects();
    // Auto-select the newly added project
    const added = get().projects.find((p) => p.name === (name ?? project.name) || p.path === path);
    if (added) set({ activeProject: added });
    return project;
  },

  setProjectColor: async (name, color) => {
    await api.patch(`/api/projects/${encodeURIComponent(name)}/color`, { color });
    await get().fetchProjects();
  },

  setProjectImage: async (name, file) => {
    const blob = await resizeImageToWebp(file);
    const form = new FormData();
    form.append("file", blob, "avatar.webp");
    const token = getAuthToken();
    // Raw fetch: api.post forces JSON Content-Type; must let the browser set
    // the multipart boundary itself, so we only attach Authorization.
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}/image`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    if (!res.ok) throw new Error("Upload failed");
    await get().fetchProjects();
    syncActiveProject(get, set, name);
  },

  removeProjectImage: async (name) => {
    await api.del(`/api/projects/${encodeURIComponent(name)}/image`);
    await get().fetchProjects();
    syncActiveProject(get, set, name);
  },

  moveProject: async (name, direction) => {
    const { projects, customOrder } = get();
    const ordered = resolveOrder(projects, customOrder);
    const idx = ordered.findIndex((p) => p.name === name);
    if (idx === -1) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ordered.length) return;
    const newOrder = ordered.map((p) => p.name);
    [newOrder[idx], newOrder[newIdx]] = [newOrder[newIdx]!, newOrder[idx]!];
    saveCustomOrder(newOrder);
    await api.patch("/api/projects/reorder", { order: newOrder });
    set({ customOrder: newOrder });
  },

  reorderProjects: async (newOrder) => {
    saveCustomOrder(newOrder);
    set({ customOrder: newOrder });
    await api.patch("/api/projects/reorder", { order: newOrder }).catch(() => {});
  },

  renameProject: async (name, newName) => {
    await api.patch(`/api/projects/${encodeURIComponent(name)}`, { name: newName });
    // Refetch to get updated list
    await get().fetchProjects();
  },

  deleteProject: async (name) => {
    await api.del(`/api/projects/${encodeURIComponent(name)}`);
    set((s) => {
      const projects = s.projects.filter((p) => p.name !== name);
      const customOrder = s.customOrder ? s.customOrder.filter((n) => n !== name) : null;
      if (customOrder) saveCustomOrder(customOrder);
      return {
        projects,
        customOrder,
        activeProject: s.activeProject?.name === name
          ? (projects[0] ?? null)
          : s.activeProject,
      };
    });
  },
}));
