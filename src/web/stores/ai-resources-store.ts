import { create } from "zustand";
import { listAiResources, type AiResourceListResult } from "@/lib/api-ai-resources";

interface AiResourcesStore {
  project: string | null;
  loading: boolean;
  error: string | null;
  result: AiResourceListResult | null;
  load: (project: string) => Promise<void>;
  reload: () => Promise<void>;
}

export const useAiResourcesStore = create<AiResourcesStore>((set, get) => ({
  project: null,
  loading: false,
  error: null,
  result: null,

  load: async (project) => {
    set({ project, loading: true, error: null });
    try {
      const result = await listAiResources(project);
      // Ignore stale responses if the project changed mid-flight.
      if (get().project !== project) return;
      set({ result, loading: false });
    } catch (e) {
      if (get().project !== project) return;
      set({ error: (e as Error).message, loading: false });
    }
  },

  reload: async () => {
    const project = get().project;
    if (project) await get().load(project);
  },
}));
