/**
 * The turns that wrote the Review tab's blocks. An open chat publishes them as it goes
 * (`useSessionTurnsStore`); with none open, the session's messages are fetched — again only when
 * a block names a call no fetch has placed yet, and not more often than every few seconds while
 * the agent is still writing.
 */
import { useEffect } from "react";
import type { ChatMessage } from "../../types/chat";
import { api, projectUrl } from "@/lib/api-client";
import { sessionTurns, turnsByCall, type SessionTurn } from "@/lib/session-turns";
import { useSessionTurnsStore } from "@/stores/session-turns-store";

const REFETCH_MS = 8_000;
const EMPTY: ReadonlyMap<string, SessionTurn> = new Map();

/** By session: when it was last fetched, and the calls the last fetch that landed could not place. */
const fetched = new Map<string, { at: number; unplaced: string | null }>();

export function useSessionTurns(p: {
  projectName?: string;
  sessionId?: string;
  providerId?: string;
  /** The calls the blocks on screen name. */
  calls: readonly string[];
}): ReadonlyMap<string, SessionTurn> {
  const { projectName, sessionId, providerId } = p;
  const entry = useSessionTurnsStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const byCall = entry?.byCall ?? EMPTY;
  const unplaced = p.calls.filter((call) => !byCall.has(call)).sort().join("\n");
  const live = entry?.live ?? false;

  useEffect(() => {
    if (!projectName || !sessionId || !providerId || live) return;
    if (entry && !unplaced) return;
    const last = fetched.get(sessionId);
    // A fetch already found nothing for these: only a new call is worth asking again for.
    if (entry && last?.unplaced === unplaced) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      fetched.set(sessionId, { at: Date.now(), unplaced: last?.unplaced ?? null });
      api
        .get<{ messages?: ChatMessage[] } | ChatMessage[]>(
          `${projectUrl(projectName)}/chat/sessions/${sessionId}/messages?providerId=${providerId}`,
          { signal: request.signal },
        )
        .then((data) => {
          const messages = Array.isArray(data) ? data : data?.messages;
          if (request.signal.aborted || !Array.isArray(messages)) return;
          const turns = sessionTurns(messages);
          const placed = turnsByCall(turns);
          fetched.set(sessionId, { at: Date.now(), unplaced: unplaced.split("\n").filter((call) => call && !placed.has(call)).join("\n") });
          // A chat that opened meanwhile knows better.
          if (useSessionTurnsStore.getState().bySession[sessionId]?.live) return;
          useSessionTurnsStore.getState().publish(sessionId, turns, false);
        })
        .catch(() => {});
    }, last ? Math.max(0, last.at + REFETCH_MS - Date.now()) : 0);
    return () => {
      clearTimeout(timer);
      request.abort();
    };
  }, [projectName, sessionId, providerId, live, !!entry, unplaced]); // eslint-disable-line react-hooks/exhaustive-deps

  return byCall;
}
