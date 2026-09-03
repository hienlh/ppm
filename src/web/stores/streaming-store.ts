import { create } from "zustand";

/** Tracks which chat sessions are currently streaming AI responses */
interface StreamingStore {
  /** sessionId → projectName ("" when unknown) for sessions actively streaming.
   *  The project is recorded so a project-scoped sync can drop stale entries
   *  without touching sessions that belong to another project. */
  sessions: Map<string, string>;
  /** Mark a session as streaming or idle */
  setStreaming: (sessionId: string, streaming: boolean, projectName?: string) => void;
  /**
   * Reconcile one project's streaming set against the server's registry, which
   * is authoritative. Needed because an `idle` broadcast missed while
   * `/ws/global` was down would otherwise leave a spinner running forever —
   * nothing else ever clears it. Scoped per project: the running list only
   * covers one project, so entries from other projects must survive.
   */
  replaceProjectStreaming: (projectName: string, sessionIds: string[]) => void;
}

export const useStreamingStore = create<StreamingStore>((set) => ({
  sessions: new Map(),
  setStreaming: (sessionId, streaming, projectName) =>
    set((state) => {
      const next = new Map(state.sessions);
      // Keep a previously recorded project when a caller omits it, so the entry
      // stays reconcilable.
      if (streaming) next.set(sessionId, projectName ?? next.get(sessionId) ?? "");
      else next.delete(sessionId);
      return { sessions: next };
    }),
  replaceProjectStreaming: (projectName, sessionIds) =>
    set((state) => {
      const running = new Set(sessionIds);
      const next = new Map(state.sessions);
      for (const [id, project] of state.sessions) {
        if (project === projectName && !running.has(id)) next.delete(id);
      }
      for (const id of sessionIds) next.set(id, projectName);
      return { sessions: next };
    }),
}));

/** Selector: true if any session is streaming */
export const selectAnyStreaming = (s: StreamingStore) => s.sessions.size > 0;
