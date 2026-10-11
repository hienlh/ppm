/**
 * Which Assistant session each connected Telegram chat talks to (`GET /api/assistant/telegram`),
 * and "use this session on Telegram" (`POST /api/assistant/telegram/bind`).
 *
 * Refetched whenever the server announces a binding change on `/ws/global`
 * (`assistant:telegram_binding_changed`, re-dispatched as a window event by `useGlobalEvents`):
 * a `/new` or `/sessions` sent from the phone moves the label in the session list without a
 * reload, and a bind made from another browser does too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";

/** The window event `useGlobalEvents` re-dispatches when a chat's session changes. */
export const TELEGRAM_BINDING_CHANGED_EVENT = "assistant:telegram_binding_changed";

export interface AssistantTelegramChat {
  chatId: string;
  name: string;
  /** The Assistant session this chat talks to; null until its first message makes one. */
  sessionId: string | null;
  sessionTitle: string | null;
}

export interface AssistantTelegramState {
  /** The bridge's switch (Settings → PPM Assistant → Telegram). */
  enabled: boolean;
  /** Whether the bridge is reading the bot right now. */
  running: boolean;
  error: string | null;
  chats: AssistantTelegramChat[];
}

export interface AssistantTelegramBinding {
  /** Null until the first answer, and after a failed one (the feature then simply hides). */
  state: AssistantTelegramState | null;
  /** Chats that may be pointed at a session: only while the bridge is switched on. */
  bindableChats: AssistantTelegramChat[];
  /** The connected chats talking to `sessionId`. */
  chatsOn: (sessionId: string) => AssistantTelegramChat[];
  bind: (sessionId: string, chatId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/** Narrows the server's answer; anything malformed reads as "no Telegram" rather than a crash. */
export function parseAssistantTelegramState(raw: unknown): AssistantTelegramState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.chats)) return null;
  const chats: AssistantTelegramChat[] = [];
  for (const c of r.chats) {
    if (!c || typeof c !== "object") continue;
    const chat = c as Record<string, unknown>;
    if (typeof chat.chatId !== "string" || !chat.chatId) continue;
    chats.push({
      chatId: chat.chatId,
      name: typeof chat.name === "string" && chat.name ? chat.name : chat.chatId,
      sessionId: typeof chat.sessionId === "string" && chat.sessionId ? chat.sessionId : null,
      sessionTitle: typeof chat.sessionTitle === "string" ? chat.sessionTitle : null,
    });
  }
  return {
    enabled: r.enabled === true,
    running: r.running === true,
    error: typeof r.error === "string" ? r.error : null,
    chats,
  };
}

export function useAssistantTelegramBinding(): AssistantTelegramBinding {
  const [state, setState] = useState<AssistantTelegramState | null>(null);
  const mounted = useRef(true);
  // Several refetches can overlap (an event lands while a bind's own refetch is in flight):
  // only the latest request may write, or an older answer could put a stale label back.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = parseAssistantTelegramState(await api.get<unknown>("/api/assistant/telegram"));
      if (mounted.current && mine === generation.current) setState(next);
    } catch {
      // A server without the bridge, or a transient failure: hide the labels and the menu item
      // rather than showing ones that may be wrong.
      if (mounted.current && mine === generation.current) setState(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener(TELEGRAM_BINDING_CHANGED_EVENT, onChanged);
    return () => {
      mounted.current = false;
      window.removeEventListener(TELEGRAM_BINDING_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  const bind = useCallback(async (sessionId: string, chatId: string) => {
    // Errors reach the caller, which says what went wrong; the list is refetched either way,
    // since a refusal ("not connected any more") also means what is shown is out of date.
    try {
      await api.post("/api/assistant/telegram/bind", { sessionId, chatId });
    } finally {
      await refresh();
    }
  }, [refresh]);

  const chats = state?.chats ?? [];
  const bindableChats = state?.enabled ? chats : [];
  const chatsOn = useCallback(
    (sessionId: string) => chats.filter((c) => c.sessionId === sessionId),
    [chats],
  );

  return { state, bindableChats, chatsOn, bind, refresh };
}
