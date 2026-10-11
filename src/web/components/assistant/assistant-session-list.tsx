/**
 * The Assistant's own sessions and the control that starts a new one.
 *
 * The list reads the shared session-list store under the Assistant's virtual project, the
 * same store the chat writes a new session into, so a session appears here the moment its
 * first message creates it. The server only ever lists Assistant sessions for that project.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus } from "@/lib/icons";
import { useAssistantTelegramBinding, type AssistantTelegramChat } from "@/hooks/use-assistant-telegram-binding";
import { AssistantSessionRow, ProviderLogo } from "./assistant-session-row";
import { ASSISTANT_PROVIDER_IDS } from "@/lib/assistant-deep-link";
import { getChatProviders, peekChatProviders, type ChatProviderInfo } from "@/lib/chat-preparation-cache";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { ASSISTANT_PROJECT_NAME } from "../../../shared/assistant-project";
import type { SessionInfo } from "../../../types/chat";

export { ASSISTANT_PROVIDER_IDS };

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

/** One "New" button per configured provider, so the choice is made by the press itself. */
export function AssistantNewSession({ providers, onNew }: {
  providers: ChatProviderInfo[];
  onNew: (providerId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onNew(p.id)}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-surface-elevated active:bg-surface-elevated md:min-h-8 md:text-xs"
          aria-label={`New Assistant session with ${p.name}`}
        >
          <Plus className="size-4 md:size-3.5" />
          <ProviderLogo providerId={p.id} className="size-4 md:size-3.5" />
          <span className="truncate">{providers.length > 1 ? p.name : "New session"}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The sessions, newest first. A session a Telegram chat talks to carries a "Telegram" label, and
 * each row's menu (right-click, or a long press on a touch screen) offers "Use on Telegram" while
 * the bridge is on and a chat is connected — one item per chat when there are several.
 */
export function AssistantSessionList({ sessions, activeSessionId, onSelect }: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (session: SessionInfo) => void;
}) {
  const rows = useMemo(() => sessions.filter((s) => ASSISTANT_PROVIDER_IDS.includes(s.providerId)), [sessions]);
  const telegram = useAssistantTelegramBinding();
  if (rows.length === 0) {
    return <p className="px-3 py-4 text-center text-sm text-text-subtle md:text-xs">No Assistant sessions yet.</p>;
  }
  const putOnTelegram = async (session: SessionInfo, chat: AssistantTelegramChat) => {
    try {
      await telegram.bind(session.id, chat.chatId);
      toast.success(`${chat.name} now talks to this session`);
    } catch (e) {
      toast.error("Could not use this session on Telegram", { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <ul className="flex flex-col py-1" aria-label="Assistant sessions">
      {rows.map((s) => (
        <AssistantSessionRow
          key={s.id}
          session={s}
          active={s.id === activeSessionId}
          onSelect={onSelect}
          boundChats={telegram.chatsOn(s.id)}
          bindableChats={telegram.bindableChats}
          onUseOnTelegram={(chat) => void putOnTelegram(s, chat)}
        />
      ))}
    </ul>
  );
}
