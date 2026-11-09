/**
 * The history window of one chat: fetches blocks of turns from the turn index and owns the view
 * state (`history-window-model.ts`). The live chat state in `use-chat.ts` is never touched.
 *
 * Every answer is checked against the generation it was asked in: leaving the window, entering
 * it again for another turn, or switching the tab to another session makes an answer still in
 * flight stale, and a stale page landing in a newer window would put turns from the wrong place
 * (or the wrong session) on screen.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { api, ApiError, projectUrl } from "@/lib/api-client";
import {
  historyWindowReducer, LIVE_VIEW, type HistoryView, type LoadDirection, type TurnWindowPage,
} from "@/lib/history-window-model";

/** How long a jump waits for its block before it says the turn could not be loaded. */
const OPEN_TIMEOUT_MS = 20_000;
/** Turns fetched per page while scrolling. */
const PAGE_TURNS = 3;

export type OpenResult = "opened" | "gone" | "failed" | "stale";

export interface HistoryWindowControls {
  view: HistoryView;
  /** The chat names a project, session and provider, so the turn index can be asked at all. */
  canOpen: boolean;
  /** Fetch the block around `turnId` and show it; resolves once it is on screen or refused. */
  open: (turnId: string) => Promise<OpenResult>;
  loadOlder: () => void;
  loadNewer: () => void;
  /** Ask again for the page that failed; the sentinels stop asking after a failure. */
  retry: (direction: LoadDirection) => void;
  exit: () => void;
}

export function useHistoryWindow(p: { projectName?: string; sessionId?: string; providerId?: string }): HistoryWindowControls {
  const { projectName, sessionId, providerId } = p;
  const [view, dispatch] = useReducer(historyWindowReducer, LIVE_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const generation = useRef(0);
  // Pages already asked for, per end: two sentinel reports in one frame would otherwise both ask.
  const inFlight = useRef({ older: false, newer: false });

  const base = projectName && sessionId && providerId
    ? `${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/turn-window?providerId=${encodeURIComponent(providerId)}`
    : null;

  const exit = useCallback(() => {
    generation.current++;
    dispatch({ type: "exit" });
  }, []);

  // Another session in this tab (a version swap, a fork) has other turns.
  useEffect(() => exit, [sessionId, exit]);

  const open = useCallback(async (turnId: string): Promise<OpenResult> => {
    if (!base) return "failed";
    const gen = ++generation.current;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OPEN_TIMEOUT_MS);
    try {
      const page = await api.get<TurnWindowPage>(`${base}&turn=${encodeURIComponent(turnId)}`, { signal: abort.signal });
      if (gen !== generation.current) return "stale";
      dispatch({ type: "enter", page, targetTurnId: turnId });
      return "opened";
    } catch (e) {
      if (gen !== generation.current) return "stale";
      // A turn a rollback removed, or one the session no longer has.
      if (e instanceof ApiError && (e.code === "not_found" || e.code === "rolled_back")) return "gone";
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }, [base]);

  const load = useCallback(async (direction: LoadDirection, retrying = false) => {
    const current = viewRef.current;
    if (!base || current.mode !== "window" || (current.loadError && !retrying)) return;
    if (direction === "older" ? !current.hasOlder || current.loadingOlder : !current.hasNewer || current.loadingNewer) return;
    const edge = direction === "older" ? current.turns[0] : current.turns[current.turns.length - 1];
    if (!edge) return;
    if (inFlight.current[direction]) return;
    inFlight.current[direction] = true;
    const gen = generation.current;
    dispatch({ type: "loading", direction });
    const param = direction === "older" ? "beforeTurn" : "afterTurn";
    try {
      const page = await api.get<TurnWindowPage>(`${base}&${param}=${encodeURIComponent(edge.turnId)}&count=${PAGE_TURNS}`);
      if (gen === generation.current) dispatch({ type: "loaded", direction, page });
    } catch (e) {
      if (gen === generation.current) dispatch({ type: "failed", direction, error: e instanceof Error ? e.message : "Could not load more turns" });
    } finally {
      inFlight.current[direction] = false;
    }
  }, [base]);

  const loadOlder = useCallback(() => void load("older"), [load]);
  const loadNewer = useCallback(() => void load("newer"), [load]);
  const retry = useCallback((direction: LoadDirection) => void load(direction, true), [load]);

  const canOpen = base !== null;
  return useMemo(() => ({ view, canOpen, open, loadOlder, loadNewer, retry, exit }), [view, canOpen, open, loadOlder, loadNewer, retry, exit]);
}
