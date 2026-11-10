/**
 * Every project's manager chat (`GET /api/assistant/managers`), shared by every component that
 * asks: fetched once when the first one mounts, then kept current by `assistant:managers_changed`
 * (re-dispatched as a window event by `useGlobalEvents`), whose payload is the whole new list.
 *
 * Session rows read {@link useIsManagerChat}: the list answers at once after an assign, while the
 * row's own `manager` flag only changes when the project's session list re-syncs.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import { MANAGERS_CHANGED_EVENT, type ManagerChatSummary } from "../../shared/assistant-managers";

interface ManagerChatsState {
  /** Null until the first answer. */
  managers: ManagerChatSummary[] | null;
}

let state: ManagerChatsState = { managers: null };
const listeners = new Set<() => void>();
let fetching = false;
let listening = false;
/** Asked once per page load: after a failure, rows keep their own flag rather than asking again per row. */
let requested = false;
/** Counts every announced change, so a fetch that started before one cannot overwrite it. */
let changes = 0;

function publish(managers: ManagerChatSummary[] | null): void {
  state = { managers };
  for (const listener of [...listeners]) listener();
}

/** Keeps only well-formed rows; anything else reads as "no manager" rather than a crash. */
export function parseManagerChats(raw: unknown): ManagerChatSummary[] {
  const list = raw && typeof raw === "object" ? (raw as { managers?: unknown }).managers : null;
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is ManagerChatSummary =>
    !!m && typeof m === "object"
    && typeof (m as ManagerChatSummary).sessionId === "string"
    && typeof (m as ManagerChatSummary).projectName === "string");
}

export async function refreshManagerChats(): Promise<void> {
  if (fetching) return;
  fetching = true;
  const asked = changes;
  try {
    const managers = parseManagerChats(await api.get<unknown>("/api/assistant/managers"));
    // An announcement that landed meanwhile is newer than this answer.
    if (asked === changes) publish(managers);
  } catch {
    // A server without manager chats, or a transient failure: rows fall back to their own flag.
  } finally {
    fetching = false;
  }
}

/** After a `/ws/global` reconnect: a change announced while the socket was down never arrived. */
export function resyncManagerChats(): void {
  if (requested) void refreshManagerChats();
}

function startListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener(MANAGERS_CHANGED_EVENT, (event) => {
    changes += 1;
    publish(parseManagerChats((event as CustomEvent).detail));
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => state;

export function useManagerChats(): ManagerChatSummary[] | null {
  useEffect(() => {
    startListening();
    if (!requested) {
      requested = true;
      void refreshManagerChats();
    }
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot).managers;
}

/**
 * Whether the session is its project's manager: from the shared list once it has loaded, else
 * from the flag the session list carried.
 */
export function useIsManagerChat(session: { id: string; manager?: boolean }): boolean {
  const managers = useManagerChats();
  return managers ? managers.some((m) => m.sessionId === session.id) : !!session.manager;
}
