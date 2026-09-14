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
   * Reconcile the whole map against the server's registry, which is authoritative.
   *
   * Needed because an `idle` broadcast missed while `/ws/global` was down — a tablet
   * asleep, a network change, a server restart mid-turn on an upgrade — otherwise leaves an
   * entry that nothing can ever clear.
   *
   * App-wide, not per project. A per-project reconcile could only reach the project the user
   * happened to be looking at, so a stale entry from any other project survived every sync
   * and stayed in the map for the life of the page. That was invisible to the favicon and the
   * title, which filter by project, but not to the screen wake lock, which asks whether
   * anything at all is running and so never let the screen sleep again.
   */
  replaceAllStreaming: (running: { sessionId: string; projectName: string }[]) => void;
  /**
   * Forget a session that the server re-keyed under a new id.
   *
   * The rename is announced on the global bus because every later phase change uses the new
   * id: the old one's `idle` is never coming. Codex re-keys every session (its thread id is
   * not PPM's), and CLI providers do it as soon as they read their real id from the output.
   */
  dropSession: (sessionId: string) => void;
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
  replaceAllStreaming: (running) =>
    set(() => ({ sessions: new Map(running.map((s) => [s.sessionId, s.projectName])) })),
  dropSession: (sessionId) =>
    set((state) => {
      if (!state.sessions.has(sessionId)) return state;
      const next = new Map(state.sessions);
      next.delete(sessionId);
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
 * No new state is needed for this: the map records the project per session, which the server's
 * running list supplies on every reconcile.
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
