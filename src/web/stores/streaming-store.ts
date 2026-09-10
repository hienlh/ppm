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

/**
 * Selector: true if a session *belonging to this project* is streaming.
 *
 * Scoped, because the thing it drives — the favicon and the document title — belongs to one
 * window, and a window shows one project. `/ws/global` carries `session:phase_changed` for
 * every project, so an unscoped "is anything streaming" made every open workspace animate
 * whenever any one of them was working: three PWA windows, one busy, three busy-looking
 * icons, and no way to tell which.
 *
 * No new state is needed for this. The map already records the project per session so
 * `replaceProjectStreaming` can reconcile one project without touching another's entries.
 */
export const selectProjectStreaming =
  (projectName: string | undefined) =>
  (s: StreamingStore): boolean => {
    if (!projectName) return false;
    for (const project of s.sessions.values()) {
      if (project === projectName) return true;
    }
    return false;
  };
