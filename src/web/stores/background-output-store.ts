import { create } from "zustand";
import type { BackgroundShell } from "../../types/api";
import { basename } from "@/lib/utils";

interface BackgroundOutputState {
  /** Tracked shells keyed by sessionId (shell ids are globally unique). */
  shellsBySession: Record<string, BackgroundShell[]>;
  /** shellId of the shell whose output panel is open, or null. */
  panelShellId: string | null;

  setSessionShells: (sessionId: string, shells: BackgroundShell[]) => void;
  /** Ref-count a session mount (a chat tab). */
  retainSession: (sessionId: string) => void;
  /** Release a session mount; clears its shells only when the last tab unmounts. */
  releaseSession: (sessionId: string) => void;
  /** Resolve a `.output` basename (or stem) to a tracked shell across all sessions. */
  findByOutput: (name: string) => BackgroundShell | undefined;
  /** Look up a shell by id across all sessions. */
  getShell: (shellId: string) => BackgroundShell | undefined;
  openPanel: (shellId: string) => void;
  closePanel: () => void;
}

/** Mount ref-counts per sessionId — outside the store state (not reactive). */
const sessionRefCounts = new Map<string, number>();

export const useBackgroundOutputStore = create<BackgroundOutputState>((set, get) => ({
  shellsBySession: {},
  panelShellId: null,

  setSessionShells: (sessionId, shells) =>
    set((s) => ({ shellsBySession: { ...s.shellsBySession, [sessionId]: shells } })),

  retainSession: (sessionId) => {
    sessionRefCounts.set(sessionId, (sessionRefCounts.get(sessionId) ?? 0) + 1);
  },

  releaseSession: (sessionId) => {
    const next = (sessionRefCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) {
      sessionRefCounts.set(sessionId, next);
      return;
    }
    // Last tab for this session — drop ref count + its shells.
    sessionRefCounts.delete(sessionId);
    set((s) => {
      const map = { ...s.shellsBySession };
      delete map[sessionId];
      return { shellsBySession: map };
    });
  },

  findByOutput: (name) => {
    if (!name) return undefined;
    const stem = basename(name).replace(/\.output$/, "");
    for (const shells of Object.values(get().shellsBySession)) {
      const match = shells.find(
        (sh) => sh.shellId === stem || sh.outputPath.endsWith(`${stem}.output`) || sh.outputPath.endsWith(name),
      );
      if (match) return match;
    }
    return undefined;
  },

  getShell: (shellId) => {
    for (const shells of Object.values(get().shellsBySession)) {
      const match = shells.find((sh) => sh.shellId === shellId);
      if (match) return match;
    }
    return undefined;
  },

  openPanel: (shellId) => set({ panelShellId: shellId }),
  closePanel: () => set({ panelShellId: null }),
}));
