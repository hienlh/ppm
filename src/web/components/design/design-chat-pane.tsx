import { Loader2 } from "@/lib/icons";
import { ChatTab } from "@/components/chat/chat-tab";
import type { useDesignSessionState } from "@/hooks/use-design-session-state";

/**
 * The design's conversation: an ordinary chat tab, embedded under the design tab's own id so
 * its session persists into — and reopens from — the design tab.
 *
 * Every exit a normal chat offers is folded back into this tab: `/clear` starts the next
 * session here, a fork is swapped in here, and the history picker lists only this design's
 * sessions. The chat is keyed on the tab's chat epoch, which is how a swapped session
 * remounts it; nothing else may remount it, or a message waiting for its socket is lost.
 */
export function DesignChatPane({ tabId, metadata, session }: {
  tabId: string;
  metadata: Record<string, unknown>;
  session: ReturnType<typeof useDesignSessionState>;
}) {
  if (session.status === "no-provider") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-subtle" role="status">
        No configured AI provider can run design sessions. Enable Claude or Codex in Settings → AI Provider.
      </div>
    );
  }
  if (session.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-text-subtle" role="status">
        Could not prepare this design's chat.
        <button type="button" onClick={session.retry} className="min-h-11 px-3 text-primary underline">Retry</button>
      </div>
    );
  }
  if (session.status !== "ready") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-subtle" role="status">
        <Loader2 className="size-4 animate-spin" /> Preparing chat…
      </div>
    );
  }
  return (
    <ChatTab
      key={session.epoch}
      tabId={tabId}
      metadata={metadata}
      onNewSession={session.startNewSession}
      onFork={session.adoptFork}
      historyFilter={String(metadata.designSlug)}
    />
  );
}
