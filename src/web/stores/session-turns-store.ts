/**
 * Each session's turns (`@/lib/session-turns`), so the Review tab can name the turn that wrote a
 * block. An open chat publishes what it shows, which puts a turn here the moment it is asked;
 * with no chat open the Review tab fetches the session's messages itself (`use-session-turns.ts`).
 */
import { create } from "zustand";
import { turnsByCall, type SessionTurn } from "@/lib/session-turns";

export interface SessionTurnsEntry {
  turns: SessionTurn[];
  /** Each call's turn. */
  byCall: Map<string, SessionTurn>;
  /** An open chat keeps it current; otherwise it is as the last fetch left it. */
  live: boolean;
}

interface SessionTurnsState {
  bySession: Record<string, SessionTurnsEntry>;
  /** Replaces the session's turns, unless they say the same thing. */
  publish: (sessionId: string, turns: SessionTurn[], live: boolean) => void;
  /** The chat showing the session closed: its turns stay, to be fetched again when they fall behind. */
  release: (sessionId: string) => void;
}

const signature = (turns: readonly SessionTurn[]) =>
  turns.map((t) => `${t.n}:${t.messageId}:${t.calls.length}:${t.calls[t.calls.length - 1] ?? ""}:${t.prompt.length}`).join("|");

export const useSessionTurnsStore = create<SessionTurnsState>((set, get) => ({
  bySession: {},
  publish: (sessionId, turns, live) => {
    const prev = get().bySession[sessionId];
    if (prev && prev.live === live && signature(prev.turns) === signature(turns)) return;
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: { turns, byCall: turnsByCall(turns), live } } }));
  },
  release: (sessionId) => {
    const prev = get().bySession[sessionId];
    if (!prev?.live) return;
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: { ...prev, live: false } } }));
  },
}));
