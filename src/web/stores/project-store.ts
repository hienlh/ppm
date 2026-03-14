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
          return { activeProject: projects[0] };
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

  setActiveProject: (project) => set({ activeProject: project }),
}));
