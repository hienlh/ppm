import { create } from "zustand";

/** Tracks which chat sessions are currently streaming AI responses */
interface StreamingStore {
  /** Set of sessionIds that are actively streaming */
  sessions: Set<string>;
  /** Mark a session as streaming or idle */
  setStreaming: (sessionId: string, streaming: boolean) => void;
}

export const useStreamingStore = create<StreamingStore>((set) => ({
  sessions: new Set(),
  setStreaming: (sessionId, streaming) =>
    set((state) => {
      const next = new Set(state.sessions);
      if (streaming) next.add(sessionId);
      else next.delete(sessionId);
      return { sessions: next };
    }),
}));

/** Selector: true if any session is streaming */
export const selectAnyStreaming = (s: StreamingStore) => s.sessions.size > 0;
