/**
 * Session review — every change one chat session made, block by block, the way Cursor and Zed
 * review an agent's edits: each block is kept, or reverted on disk, where it sits in its file,
 * and every answer can be undone. Opened from the changes bar above the composer; one tab per
 * session. The state lives in `useSessionReview`; this picks the desktop or the phone layout.
 */
import { useCallback, useMemo } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSessionReview } from "@/hooks/use-session-review";
import { useSessionTurns } from "@/hooks/use-session-turns";
import type { SessionTurn } from "@/lib/session-turns";
import { useChatJumpStore } from "@/stores/chat-jump-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { nameAndDir } from "./review-parts";
import { reviewView } from "./review-view";
import { ReviewDesktop } from "./review-desktop";
import { ReviewPhone } from "./review-phone";

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function SessionReviewTab({ metadata }: { metadata?: Record<string, unknown> }) {
  const projectName = metadata?.projectName as string | undefined;
  const sessionId = metadata?.sessionId as string | undefined;
  const providerId = metadata?.providerId as string | undefined;
  const chatTitle = metadata?.chatTitle as string | undefined;
  const isMobile = useIsMobile();
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.name === projectName)?.path);
  const review = useSessionReview({
    projectName,
    sessionId,
    paths: stringList(metadata?.paths),
    select: metadata?.select as { path?: string; at?: number } | undefined,
  });

  const openChat = useCallback(() => {
    if (!projectName || !sessionId) return;
    useTabStore.getState().openTab({
      type: "chat",
      title: chatTitle || "Chat",
      projectId: projectName,
      metadata: { projectName, sessionId, ...(providerId ? { providerId } : {}) },
      closable: true,
    });
  }, [projectName, sessionId, providerId, chatTitle]);
  const showInChat = useCallback((turn: SessionTurn, call: string) => {
    if (!sessionId) return;
    useChatJumpStore.getState().jump({ sessionId, toolUseId: call, messageId: turn.messageId });
    openChat();
  }, [sessionId, openChat]);
  const calls = useMemo(() => review.reviews.flatMap((r) => r.file.blocks?.flatMap((b) => b.calls ?? []) ?? []), [review.reviews]);
  const turns = useSessionTurns({ projectName, sessionId, providerId, calls });
  const openFile = useCallback((path: string) => {
    if (!projectName) return;
    useTabStore.getState().openTab({
      type: "editor",
      title: nameAndDir(path, undefined).base,
      metadata: { filePath: path, projectName },
      projectId: projectName,
      closable: true,
    });
  }, [projectName]);

  if (!projectName || !sessionId) {
    return <div className="flex h-full items-center justify-center text-sm text-text-3">No chat session.</div>;
  }
  const view = reviewView({ review, projectPath, providerId, chatTitle, openChat, openFile, turns, showInChat });
  return isMobile ? <ReviewPhone view={view} /> : <ReviewDesktop view={view} />;
}
