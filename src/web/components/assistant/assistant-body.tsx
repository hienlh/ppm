/**
 * The Assistant tab's body: its sessions beside (or, when narrow, behind) one chat.
 *
 * The chat is an ordinary `ChatTab` in the virtual `__assistant__` project, embedded under
 * the Assistant tab's own id so the session it runs persists into the tab's metadata. Every
 * exit a normal chat offers is folded back into this tab — `/clear` and the "New" buttons
 * start the next session here, a fork is swapped in here — and the chat is keyed on the
 * tab's chat epoch, which is how a swapped session remounts it.
 *
 * The layout follows the body's own width (`@container`), since a floating window and a
 * phone screen can be equally narrow; only the drawer's presentation depends on the device.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, History, X } from "@/lib/icons";
import { ChatTab, type ChatForkRequest } from "@/components/chat/chat-tab";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { readChatPreparationSettings } from "@/lib/chat-preference-local-cache";
import { nextAssistantChatEpoch } from "./open-assistant";
import {
  AssistantNewSession, AssistantSessionList, useAssistantProviders, useAssistantSessions,
} from "./assistant-session-list";
import { ASSISTANT_PROJECT_NAME } from "../../../shared/assistant-project";
import type { SessionInfo } from "../../../types/chat";

/** What an Assistant chat always runs with: the server asks before every change regardless. */
const ASSISTANT_PERMISSION = { permissionMode: "default", permissionModeSource: "user" } as const;

export function AssistantBody({ tabId, metadata }: { tabId: string; metadata: Record<string, unknown> }) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { providers, error } = useAssistantProviders();
  const { sessions, synced } = useAssistantSessions();
  const sessionId = typeof metadata.sessionId === "string" && metadata.sessionId ? metadata.sessionId : null;
  const providerId = typeof metadata.providerId === "string" && metadata.providerId ? metadata.providerId : null;
  const epoch = typeof metadata.assistantChatEpoch === "number" ? metadata.assistantChatEpoch : 0;

  /** Swap the chat to another session (or none): one metadata write, one remount. */
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
    setDrawerOpen(false);
  }, [tabId, metadata]);

  // A first open carries no provider: take the default one when it can run the Assistant,
  // else the first that can. Nothing to pick until the list has loaded.
  useEffect(() => {
    if (sessionId || providerId || !providers?.length) return;
    const preferred = readChatPreparationSettings()?.default_provider;
    const pick = providers.find((p) => p.id === preferred) ?? providers[0]!;
    patchTabMetadata(tabId, { providerId: pick.id, ...ASSISTANT_PERMISSION, projectName: ASSISTANT_PROJECT_NAME });
  }, [sessionId, providerId, providers, tabId]);

  // A session named without its provider (a notification knows only the id): the list says
  // which provider runs it. One the list does not hold is opened as Claude, the chat default.
  useEffect(() => {
    if (!sessionId || providerId) return;
    const known = sessions.find((s) => s.id === sessionId)?.providerId;
    if (known || synced) patchTabMetadata(tabId, { providerId: known ?? "claude", ...ASSISTANT_PERMISSION });
  }, [sessionId, providerId, sessions, synced, tabId]);

  const handleNew = useCallback((id: string) => swap({ sessionId: undefined, providerId: id }), [swap]);
  const handleSelect = useCallback((s: SessionInfo) => {
    if (s.id === sessionId) { setDrawerOpen(false); return; }
    swap({ sessionId: s.id, providerId: s.providerId });
  }, [swap, sessionId]);
  const handleClear = useCallback((clearedFrom?: string) => swap({ sessionId: undefined, clearedFrom }), [swap]);
  const handleFork = useCallback((fork: ChatForkRequest) => swap({
    sessionId: fork.sessionId, providerId: fork.providerId, pendingMessage: fork.pendingMessage,
  }), [swap]);

  const sidebar = (
    <>
      <div className="shrink-0 p-2">
        {providers?.length ? <AssistantNewSession providers={providers} onNew={handleNew} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AssistantSessionList sessions={sessions} activeSessionId={sessionId} onSelect={handleSelect} />
      </div>
    </>
  );

  let chat: React.ReactNode;
  if (providers && providers.length === 0) {
    chat = (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-subtle" role="status">
        {error
          ? "Could not load the AI providers. Reopen the Assistant to try again."
          : "No configured AI provider can run the Assistant. Enable Claude or Codex in Settings → AI Provider."}
      </div>
    );
  } else if (!providerId) {
    chat = (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-subtle" role="status">
        <Loader2 className="size-4 animate-spin" /> Preparing the Assistant…
      </div>
    );
  } else {
    chat = (
      <ChatTab key={epoch} tabId={tabId} metadata={metadata} onNewSession={handleClear} onFork={handleFork} />
    );
  }

  return (
    <div className="@container/assistant relative flex h-full min-h-0">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border @[720px]/assistant:flex">{sidebar}</aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 @[720px]/assistant:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-text-secondary hover:bg-surface-elevated active:bg-surface-elevated md:min-h-8 md:text-xs"
            aria-label="Assistant sessions"
          >
            <History className="size-4 md:size-3.5" />
            <span>Sessions</span>
          </button>
        </div>
        <div className="min-h-0 flex-1">{chat}</div>
      </div>

      {isMobile ? (
        <BottomSheet open={drawerOpen} onClose={() => setDrawerOpen(false)} className="flex max-h-[85vh] flex-col">
          <div className="px-4 pb-1 pt-1 text-sm font-medium text-text-primary">Assistant sessions</div>
          {sidebar}
        </BottomSheet>
      ) : drawerOpen && (
        <div className="absolute inset-0 z-40 flex @[720px]/assistant:hidden">
          <div className="flex w-72 max-w-[85%] flex-col border-r border-border bg-panel shadow-[var(--shadow-panel)]">
            <div className="flex shrink-0 items-center justify-between px-3 py-2">
              <span className="text-xs font-medium text-text-primary">Assistant sessions</span>
              <button type="button" onClick={() => setDrawerOpen(false)} className="rounded p-1 hover:bg-surface-elevated" aria-label="Close sessions">
                <X className="size-3.5" />
              </button>
            </div>
            {sidebar}
          </div>
          <button type="button" aria-label="Close sessions" className="flex-1 bg-black/20" onClick={() => setDrawerOpen(false)} />
        </div>
      )}
    </div>
  );
}
