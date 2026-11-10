/**
 * The main Assistant session (`GET /api/assistant/main-session`): the one Telegram follows and the
 * Assistant window opens on. Fetched once by the first reader, then kept current by
 * `assistant:main_session_changed` (both ids null once it was cleared).
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import { MAIN_SESSION_CHANGED_EVENT } from "../../shared/assistant-managers";

export interface MainSessionState {
  /** False until the first answer (or a failed one). */
  loaded: boolean;
  sessionId: string | null;
  providerId: string | null;
}

let state: MainSessionState = { loaded: false, sessionId: null, providerId: null };
const listeners = new Set<() => void>();
let started = false;

function publish(next: MainSessionState): void {
  state = next;
  for (const l of [...listeners]) l();
}

/** The main session from an answer or an event, or null for none. */
export function parseMainSession(raw: unknown): { sessionId: string; providerId: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { sessionId?: unknown; providerId?: unknown };
  return typeof r.sessionId === "string" && r.sessionId
    ? { sessionId: r.sessionId, providerId: typeof r.providerId === "string" && r.providerId ? r.providerId : "claude" }
    : null;
}

async function refresh(): Promise<void> {
  try {
    const res = await api.get<{ main?: unknown }>("/api/assistant/main-session");
    const main = parseMainSession(res?.main);
    publish({ loaded: true, sessionId: main?.sessionId ?? null, providerId: main?.providerId ?? null });
  } catch {
    publish({ ...state, loaded: true });
  }
}

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(MAIN_SESSION_CHANGED_EVENT, (event) => {
    const main = parseMainSession((event as CustomEvent).detail);
    publish({ loaded: true, sessionId: main?.sessionId ?? null, providerId: main?.providerId ?? null });
  });
  void refresh();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => state;

export function useAssistantMainSession(): MainSessionState {
  useEffect(() => start(), []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
