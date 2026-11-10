/**
 * Which Assistant session the window's chat runs. A fresh open shows the main session (the one
 * Telegram follows); a notification or Settings may name another, which is then a one-off the
 * window offers to leave. With no main session yet, a new session starts on the Assistant's
 * provider and the server makes it the main one.
 *
 * Every switch is one metadata write and one remount of the chat, keyed on the tab's chat epoch.
 */
import { useCallback, useEffect, useState } from "react";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { readChatPreparationSettings } from "@/lib/chat-preference-local-cache";
import { getAssistantSettings } from "@/lib/assistant-settings-api";
import { useAssistantMainSession } from "@/hooks/use-assistant-main-session";
import { nextAssistantChatEpoch } from "./open-assistant";
import { useAssistantProviders, useAssistantSessions } from "./assistant-session-list";
import { ASSISTANT_PROJECT_NAME } from "../../../shared/assistant-project";

/** What an Assistant chat always runs with: the server asks before every change regardless. */
const ASSISTANT_PERMISSION = { permissionMode: "default", permissionModeSource: "user" } as const;

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function useAssistantSessionChoice(tabId: string, metadata: Record<string, unknown>) {
  const { providers, error } = useAssistantProviders();
  const { sessions, synced } = useAssistantSessions();
  const main = useAssistantMainSession();
  const sessionId = str(metadata.sessionId);
  const providerId = str(metadata.providerId);
  const epoch = typeof metadata.assistantChatEpoch === "number" ? metadata.assistantChatEpoch : 0;

  const swap = useCallback((patch: Record<string, unknown>) => {
    patchTabMetadata(tabId, {
      pendingMessage: undefined,
      clearedFrom: undefined,
      ...ASSISTANT_PERMISSION,
      ...patch,
      projectName: ASSISTANT_PROJECT_NAME,
      // Read at write time: the prop can be a render behind a write the chat just made.
      assistantChatEpoch: nextAssistantChatEpoch(currentTabMetadata(tabId) ?? metadata),
    });
  }, [tabId, metadata]);

  // A fresh open (no session, no provider picked) shows the main session.
  const fresh = !sessionId && !providerId;
  useEffect(() => {
    if (fresh && main.loaded && main.sessionId) swap({ sessionId: main.sessionId, providerId: main.providerId ?? "claude" });
  }, [fresh, main.loaded, main.sessionId, main.providerId, swap]);

  // No main session yet: a new one on the Assistant's default provider, else the chat default
  // when it can run the Assistant, else the first that can. Nothing to pick until all answered.
  const [assistantDefault, setAssistantDefault] = useState<string | null | undefined>(undefined);
  const needsProvider = fresh && main.loaded && !main.sessionId;
  useEffect(() => {
    if (!needsProvider || assistantDefault !== undefined) return;
    let active = true;
    getAssistantSettings()
      .then((res) => { if (active) setAssistantDefault(res.settings.default_provider); })
      .catch(() => { if (active) setAssistantDefault(null); });
    return () => { active = false; };
  }, [needsProvider, assistantDefault]);
  useEffect(() => {
    if (!needsProvider || !providers?.length || assistantDefault === undefined) return;
    const preferred = [assistantDefault, readChatPreparationSettings()?.default_provider];
    const pick = preferred.map((id) => providers.find((p) => p.id === id)).find(Boolean) ?? providers[0]!;
    patchTabMetadata(tabId, { providerId: pick.id, ...ASSISTANT_PERMISSION, projectName: ASSISTANT_PROJECT_NAME });
  }, [needsProvider, providers, assistantDefault, tabId]);

  // A session named without its provider (a notification knows only the id): the list says which
  // provider runs it. One the list does not hold is opened as Claude, the chat default.
  useEffect(() => {
    if (!sessionId || providerId) return;
    const known = sessionId === main.sessionId ? main.providerId : sessions.find((s) => s.id === sessionId)?.providerId;
    if (known || synced) patchTabMetadata(tabId, { providerId: known ?? "claude", ...ASSISTANT_PERMISSION });
  }, [sessionId, providerId, sessions, synced, tabId, main.sessionId, main.providerId]);

  const oneOff = !!sessionId && !!main.sessionId && sessionId !== main.sessionId;
  const backToMain = useCallback(() => {
    if (main.sessionId) swap({ sessionId: main.sessionId, providerId: main.providerId ?? "claude" });
  }, [main.sessionId, main.providerId, swap]);

  return { providers, error, sessionId, providerId, epoch, swap, oneOff, backToMain, mainSessionId: main.sessionId };
}
