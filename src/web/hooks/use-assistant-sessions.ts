/**
 * The Assistant's own sessions and the providers that can run one, shared by the Assistant window
 * (which session it opens on) and Settings → PPM Assistant (the session list and main picker).
 *
 * The list reads the shared session-list store under the Assistant's virtual project, the
 * same store the chat writes a new session into, so a session appears the moment its first
 * message creates it. The server only ever lists Assistant sessions for that project.
 */
import { useEffect, useState } from "react";
import { ASSISTANT_PROVIDER_IDS } from "@/lib/assistant-deep-link";
import { getChatProviders, peekChatProviders, type ChatProviderInfo } from "@/lib/chat-preparation-cache";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project";
import type { SessionInfo } from "../../types/chat";

export interface AssistantProviders {
  /** Configured providers that can run the Assistant; null while loading. */
  providers: ChatProviderInfo[] | null;
  error: boolean;
}

/** Only a provider the server says will enforce the Assistant's policy is offered. */
function supported(list: ChatProviderInfo[] | undefined): ChatProviderInfo[] | null {
  return list ? list.filter((p) => ASSISTANT_PROVIDER_IDS.includes(p.id) && p.supportsAssistantSessions === true) : null;
}

/** Configured providers among the ones the Assistant supports. */
export function useAssistantProviders(): AssistantProviders {
  const [state, setState] = useState<AssistantProviders>(() => ({
    providers: supported(peekChatProviders(ASSISTANT_PROJECT_NAME)), error: false,
  }));
  useEffect(() => {
    let active = true;
    getChatProviders(ASSISTANT_PROJECT_NAME)
      .then((list) => { if (active) setState({ providers: supported(list), error: false }); })
      .catch(() => { if (active) setState((prev) => ({ providers: prev.providers ?? [], error: true })); });
    return () => { active = false; };
  }, []);
  return state;
}

/** The Assistant's sessions, newest activity first, synced in the background. */
export function useAssistantSessions(): { sessions: SessionInfo[]; synced: boolean } {
  const project = useProjectRef(ASSISTANT_PROJECT_NAME);
  const id = project ? projectCacheId(project) : null;
  useEffect(() => {
    if (project) void useSessionListStore.getState().ensure(project);
  }, [project]);
  const sessions = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);
  // Answered by the server at least once — or failed to be: either way, waiting longer for a
  // session that is not in the list will not make it appear.
  const synced = useSessionListStore((s) => {
    const state = id ? s.byProject[id] : undefined;
    return Boolean(state && (state.lastSyncedAt !== null || state.lastSyncError));
  });
  return { sessions, synced };
}
