import { create } from "zustand";
import type { ProjectInfo } from "../../types/project";
import { api } from "../lib/api-client";

interface ProjectStore {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  loading: boolean;
  fetchProjects(): Promise<void>;
  setActiveProject(project: ProjectInfo): void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  projects: [],
  activeProject: null,
  loading: false,

  async fetchProjects() {
    set({ loading: true });
    try {
      const projects = await api.get<ProjectInfo[]>("/api/projects");
      set({ projects });
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    } finally {
      set({ loading: false });
    }
  },

  setActiveProject(project) {
    set({ activeProject: project });
  },
}));
