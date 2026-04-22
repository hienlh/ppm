import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useProjectStore } from "@/stores/project-store";

/** Selection captured when user picks a file "for compare". */
export interface CompareSelection {
  filePath: string;
  projectName: string;
  /** Captured snapshot of dirty editor buffer — undefined if file was clean. */
  dirtyContent?: string;
  /** Display name (basename) for menu/dialog UI. */
  label: string;
}

interface CompareStore {
  selection: CompareSelection | null;
  setSelection: (sel: CompareSelection) => void;
  clearSelection: () => void;
}

/** Avoid persisting huge dirty buffers (>500KB) to keep localStorage fast. */
const MAX_DIRTY_PERSIST_BYTES = 500_000;

export const useCompareStore = create<CompareStore>()(
  persist(
    (set) => ({
      selection: null,
      setSelection: (sel) => set({ selection: sel }),
      clearSelection: () => set({ selection: null }),
    }),
    {
      name: "ppm:compare-selection",
      // Strip oversized dirtyContent before persisting — keep the path so user
      // can still compare (content will be re-fetched from disk).
      partialize: (s) => {
        if (!s.selection) return { selection: null };
        const sel = s.selection;
        if (sel.dirtyContent && sel.dirtyContent.length > MAX_DIRTY_PERSIST_BYTES) {
          const { dirtyContent: _, ...rest } = sel;
          return { selection: rest };
        }
        return { selection: sel };
      },
    },
  ),
);

// Auto-clear selection when the user switches active project.
// Tracked in module scope to avoid clearing on the initial load hydration.
let lastActiveProject: string | null = null;
useProjectStore.subscribe((state) => {
  const now = state.activeProject?.name ?? null;
  if (lastActiveProject !== null && lastActiveProject !== now) {
    useCompareStore.getState().clearSelection();
  }
  lastActiveProject = now;
});
