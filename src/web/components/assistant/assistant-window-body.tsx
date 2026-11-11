/**
 * The Assistant: a head (only where no window titlebar carries the name and gear), the chip row,
 * and one stream — the main session's chat with the cards placed among its messages by time.
 * Answering a card in your own words puts the reply-to bar where the composer is.
 *
 * The chat is an ordinary `ChatTab` in the virtual `__assistant__` project, embedded under the
 * Assistant tab's own id so the session it runs persists into the tab's metadata. `/clear` and a
 * fork are folded back into this tab, keyed on the tab's chat epoch.
 */
import { useCallback, useEffect } from "react";
import { Loader2 } from "@/lib/icons";
import { ChatTab, type ChatForkRequest } from "@/components/chat/chat-tab";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePanelStore } from "@/stores/panel-store";
import { isWindowPanelId } from "@/stores/panel-utils";
import { useCardReplyStore } from "@/stores/assistant-card-reply-store";
import { CardReplyBar } from "./cards/card-reply-bar";
import { AssistantHead } from "./assistant-head";
import { ManagerChipRow } from "./manager-chip-row";
import { useAssistantSessionChoice } from "./use-assistant-session-choice";
import { useAssistantStreamTimeline } from "./use-assistant-stream-timeline";

export const ONE_OFF_LABEL = "One-off session";
export const BACK_TO_MAIN_LABEL = "Back to main";

function useInWindow(tabId: string): boolean {
  return usePanelStore((s) => Object.values(s.panels).some((p) => isWindowPanelId(p.id) && p.tabs.some((t) => t.id === tabId)));
}

export function AssistantWindowBody({ tabId, metadata }: { tabId: string; metadata: Record<string, unknown> }) {
  const isMobile = useIsMobile();
  const inWindow = useInWindow(tabId);
  const choice = useAssistantSessionChoice(tabId, metadata);
  const { providers, error, sessionId, providerId, epoch, swap, oneOff, backToMain, followBranch } = choice;
  const timeline = useAssistantStreamTimeline();
  const replying = useCardReplyStore((s) => s.target !== null);
  const closeReply = useCardReplyStore((s) => s.close);

  // Reply-to mode belongs to the session it was opened over.
  useEffect(() => { closeReply(); }, [sessionId, closeReply]);

  const handleClear = useCallback((clearedFrom?: string) => swap({ sessionId: undefined, clearedFrom }), [swap]);
  const handleFork = useCallback((fork: ChatForkRequest) => {
    swap({ sessionId: fork.sessionId, providerId: fork.providerId, pendingMessage: fork.pendingMessage });
    followBranch(sessionId, fork.sessionId);
  }, [swap, followBranch, sessionId]);

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
      <ChatTab
        key={epoch}
        tabId={tabId}
        metadata={metadata}
        onNewSession={handleClear}
        onFork={handleFork}
        onBranchSwitch={followBranch}
        timeline={timeline}
        composerOverride={replying ? <CardReplyBar /> : undefined}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-assistant-body="">
      {(isMobile || !inWindow) && <AssistantHead sessionId={sessionId} />}
      <ManagerChipRow />
      {oneOff && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-wash px-3 text-xs text-text-secondary" data-one-off="">
          <span>{ONE_OFF_LABEL}</span>·
          <button type="button" onClick={backToMain} className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-8">
            {BACK_TO_MAIN_LABEL}
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">{chat}</div>
    </div>
  );
}
