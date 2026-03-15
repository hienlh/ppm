import { create } from "zustand";
import { api } from "@/lib/api-client";

export interface Project {
  name: string;
  path: string;
}

export interface ProjectInfo extends Project {
  branch?: string;
  status?: "clean" | "dirty";
}

// ---------------------------------------------------------------------------
// Recently-used tracking via localStorage
// ---------------------------------------------------------------------------
const RECENT_KEY = "ppm-recent-projects";

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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface ProjectStore {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  setActiveProject: (project: ProjectInfo) => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  projects: [],
  activeProject: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await api.get<ProjectInfo[]>("/api/projects");
      set({ projects, loading: false });
      // Auto-select first project if none active
      set((s) => {
        if (!s.activeProject && projects.length > 0) {
          const sorted = sortByRecent(projects);
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
    touchRecent(project.name);
    set({ activeProject: project });
  },
}));
