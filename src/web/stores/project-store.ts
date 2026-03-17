import { create } from "zustand";
import { api } from "@/lib/api-client";
import { parseUrlState } from "@/hooks/use-url-sync";

export interface Project {
  name: string;
  path: string;
  color?: string;
}

export interface ProjectInfo extends Project {
  branch?: string;
  status?: "clean" | "dirty";
}

// ---------------------------------------------------------------------------
// Recently-used tracking via localStorage
// ---------------------------------------------------------------------------
const RECENT_KEY = "ppm-recent-projects";
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

/** Move project name to front of recent list */
function touchRecent(name: string) {
  const order = loadRecentOrder().filter((n) => n !== name);
  order.unshift(name);
  saveRecentOrder(order);
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
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  setActiveProject: (project: ProjectInfo) => void;
  addProject: (path: string, name?: string) => Promise<ProjectInfo>;
  setProjectColor: (name: string, color: string | null) => Promise<void>;
  moveProject: (name: string, direction: "up" | "down") => Promise<void>;
  reorderProjects: (newOrder: string[]) => Promise<void>;
  renameProject: (name: string, newName: string) => Promise<void>;
  deleteProject: (name: string) => Promise<void>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeProject: null,
  customOrder: loadCustomOrder(),
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await api.get<ProjectInfo[]>("/api/projects");
      set({ projects, loading: false });
      // Auto-select: restore from URL first, then fall back to first project
      set((s) => {
        if (!s.activeProject && projects.length > 0) {
          const { projectName: urlProject } = parseUrlState();
          if (urlProject) {
            const match = projects.find((p) => p.name === urlProject);
            if (match) return { activeProject: match };
          }
          const sorted = resolveOrder(projects, s.customOrder);
          return { activeProject: sorted[0] };
        }
        return {};
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch projects",
        loading: false,
      });
    }
  },

  setActiveProject: (project) => {
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
