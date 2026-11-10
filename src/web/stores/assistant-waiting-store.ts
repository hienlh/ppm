/**
 * How many PPM Assistant cards wait on the user, in all and per project: the red count on the rail
 * button, the dock chip, the drawer tile and each manager chip. Fetched once (`GET /waiting`) by
 * the first reader, then kept current by `assistant:waiting_changed` (re-dispatched as a window
 * event by `useGlobalEvents`) and refetched after a `/ws/global` reconnect. Nothing polls.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { ASSISTANT_WAITING_EVENT, fetchAssistantWaiting } from "@/lib/assistant-cards-api";
import type { AssistantWaiting } from "../../shared/assistant-cards";

interface WaitingState extends AssistantWaiting {
  loaded: boolean;
}

export const useAssistantWaitingStore = create<WaitingState>(() => ({ total: 0, byProject: {}, loaded: false }));

/** Counts from an event's detail or an answer, or null when they are not counts. */
export function parseWaiting(raw: unknown): AssistantWaiting | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { total?: unknown; byProject?: unknown };
  if (typeof r.total !== "number" || !Number.isFinite(r.total)) return null;
  const byProject: Record<string, number> = {};
  if (r.byProject && typeof r.byProject === "object") {
    for (const [k, v] of Object.entries(r.byProject as Record<string, unknown>)) if (typeof v === "number") byProject[k] = v;
  }
  return { total: Math.max(0, r.total), byProject };
}

let started = false;
/** Counts every event, so a fetch that started before one cannot overwrite it. */
let changes = 0;

async function refresh(): Promise<void> {
  const asked = changes;
  try {
    const counts = parseWaiting(await fetchAssistantWaiting());
    if (counts && asked === changes) useAssistantWaitingStore.setState({ ...counts, loaded: true });
  } catch {
    // A server without the Assistant, or a transient failure: the counts stay as they were.
  }
}

/** Starts following the counts; a no-op after the first call. */
export function ensureAssistantWaiting(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(ASSISTANT_WAITING_EVENT, (event) => {
    const counts = parseWaiting((event as CustomEvent).detail);
    if (!counts) return;
    changes += 1;
    useAssistantWaitingStore.setState({ ...counts, loaded: true });
  });
  void refresh();
}

/** After a `/ws/global` reconnect: a change announced while the socket was down never arrived. */
export function resyncAssistantWaiting(): void {
  if (started) void refresh();
}

/** The total waiting count, following it from the first mount where `enabled`. */
export function useAssistantWaitingTotal(enabled = true): number {
  useEffect(() => { if (enabled) ensureAssistantWaiting(); }, [enabled]);
  return useAssistantWaitingStore((s) => s.total);
}

/** Waiting cards per project name. */
export function useAssistantWaitingByProject(): Record<string, number> {
  useEffect(() => ensureAssistantWaiting(), []);
  return useAssistantWaitingStore((s) => s.byProject);
}
