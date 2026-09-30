/**
 * Mobile-only: which agent/teammate session the full-screen sheet is showing, if any.
 *
 * Kept separate from `use-open-agent-session.ts` (unlike the old `team-member` stack, which
 * had it inline) so `agent-session-fallback-store.ts` can read this store to decide what is
 * still on screen without importing the opener — the opener already imports the fallback
 * store to seed it on open, and a two-way import between them would make the eval order of
 * two zustand `create()` calls load-bearing.
 */
import { create } from "zustand";
import type { AgentSessionWindowPayload } from "./agent-session-window-content";

interface AgentSessionSheetState {
  payload: AgentSessionWindowPayload | null;
  open: (payload: AgentSessionWindowPayload) => void;
  close: () => void;
}

export const useAgentSessionSheetStore = create<AgentSessionSheetState>((set) => ({
  payload: null,
  open: (payload) => set({ payload }),
  close: () => set({ payload: null }),
}));
