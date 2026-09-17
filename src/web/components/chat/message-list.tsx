import { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect, memo } from "react";
import { userMessageOrdinals } from "@/lib/message-ordinals";
import { useStickToBottom } from "use-stick-to-bottom";
import type { ChatMessage } from "../../../types/chat";
import type { SessionPhase } from "../../../types/api";
import type { BashPartialEntry } from "../../hooks/use-chat";
import { ToolCard } from "./tool-cards";
import { jumpToEdit } from "./jump-to-edit";
import {
  aggregateTurnFileChanges,
  collectTurnMessages,
  type TurnFileChange,
} from "@/lib/aggregate-turn-file-changes";
import { TurnChangeRollup } from "./turn-change-rollup";
import { TurnCostWarning } from "./turn-cost-warning";
import { TaskTracker } from "./task-tracker";
import { extractJsonlPath } from "./pre-compact-button";
import { MarkdownContent } from "./message-markdown";
import { UserBubble } from "./message-user-bubble";
import { InterleavedEvents, ThinkingIndicator } from "./message-events";
import { RenderErrorBoundary } from "@/components/shared/markdown-error-boundary";

import {
  AlertCircle,
  ShieldAlert,
  Bot,
  Copy,
  Check,
  Loader2,
  XCircle,
} from "@/lib/icons";
import { ChatWelcome } from "./chat-welcome";
import { ChatScrollNav } from "./chat-scroll-nav";
import type { VersionGroup } from "../../../types/api";
import { QuestionCard } from "./question-card";
import type { Question } from "./question-card";
import { GALLERY_ROOT_ATTR } from "@/lib/image-gallery";

interface MessageListProps {
  messages: ChatMessage[];
  messagesLoading?: boolean;
  /** Keep the current (stale) transcript on screen while loading instead of the
   * full-screen loading state — used for same-tree version swaps where the
   * prefix is identical, so only the divergent tail visibly changes. */
  keepStaleWhileLoading?: boolean;
  pendingApproval: { requestId: string; tool: string; input: unknown } | null;
  onApprovalResponse: (requestId: string, approved: boolean, data?: unknown) => void;
  isStreaming: boolean;
  phase?: SessionPhase;
  connectingElapsed?: number;
  statusMessage?: string | null;
  compactStatus?: "compacting" | null;
  projectName?: string;
  /** Called when user clicks Fork/Rewind — opens new forked chat tab */
  onFork?: (userMessage: string, messageId?: string) => void;
  /** Called when user clicks Edit — prefills input, forks + continues in the SAME tab on send.
   * `messageId` = fork anchor (prev message), `ownMsgId` = the edited message's own id. */
  onEdit?: (userMessage: string, messageId?: string, ownMsgId?: string) => void;
  /** Own id of the message currently armed for edit — highlighted in the list. */
  editingMsgId?: string;
  /** Current session id — used by the version switcher to resolve sibling edits */
  sessionId?: string;
  /** Provider id for version-switcher lookups */
  providerId?: string;
  /** Swap the tab to another version's session (used by the version switcher) */
  onNavigateVersion?: (sessionId: string) => void;
  /** Edited-version groups keyed by user-message ordinal, from the /messages
   *  response. A missing ordinal means that message has no alternate versions. */
  versionMap?: Record<number, VersionGroup>;
  /** Called when user selects a recent session from the welcome screen */
  onSelectSession?: (session: import("../../../types/chat").SessionInfo) => void;
  /** Dismiss a single message (removes from local view only — not persisted history) */
  onDismissMessage?: (messageId: string) => void;
  /** Remove all system/error bubbles from the local view */
  onClearErrors?: () => void;
  /** Partial bash output ref from useChat for real-time streaming */
  bashPartialOutput?: React.RefObject<Map<string, BashPartialEntry>>;
  /** Fetches pre-compact transcript and prepends messages. Returns loaded count. */
  onExpandCompact?: (compactMessageId: string, jsonlPath: string) => Promise<number>;
  /** Whether a given compact message has already been expanded. */
  isCompactExpanded?: (compactMessageId: string) => boolean;
}

/**
 * Placeholder for a compaction segment being fetched.
 *
 * It sits in the flow rather than floating, so scrolling up lands on something
 * the size of the turns that are coming instead of a blank gap that then jerks
 * downward. The layout effect that preserves distance-from-bottom is what keeps
 * inserting it from moving the messages already on screen.
 */
function PreCompactSkeleton() {
  return (
    <div
      className="px-4 pt-4 space-y-4"
      aria-busy="true"
      aria-label="Loading previous conversation"
    >
      <div className="flex items-center justify-center gap-1.5 text-xs text-text-secondary">
        <Loader2 className="size-3 animate-spin" />
        Loading previous conversation…
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className={i % 2 === 0 ? "flex justify-end" : "flex justify-start"}>
          <div
            className={`animate-pulse space-y-2 rounded-lg bg-surface p-3 ${i % 2 === 0 ? "w-1/2" : "w-3/4"}`}
          >
            <div className="h-3 rounded bg-border" />
            <div className="h-3 w-5/6 rounded bg-border" />
            {i % 2 === 1 && <div className="h-3 w-2/3 rounded bg-border" />}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MessageList({
  messages,
  messagesLoading,
  keepStaleWhileLoading,
  pendingApproval,
  onApprovalResponse,
  isStreaming,
  phase,
  onSelectSession,
  connectingElapsed,
  statusMessage,
  compactStatus,
  projectName,
  onFork,
  onEdit,
  editingMsgId,
  sessionId,
  providerId,
  onNavigateVersion,
  versionMap,
  bashPartialOutput,
  onExpandCompact,
  isCompactExpanded,
  onDismissMessage,
  onClearErrors,
}: MessageListProps) {
  // Non-virtualized transcript: every message lives in the real DOM. Content that
  // grows BELOW the viewport (streaming) no longer shifts the user's scroll — that's
  // native browser behavior, not something we compute. use-stick-to-bottom owns the
  // only scroll write: follow-to-bottom while locked, release the lock on user
  // up-scroll, re-lock when the user returns to the bottom.
  const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  });

  const filtered = useMemo(() => messages.filter((msg) => {
    const hasContent = msg.content && msg.content.trim().length > 0;
    const hasEvents = msg.events && msg.events.length > 0;
    // User bubbles only render text — hide SDK tool-result user messages
    // that have no text content (their events are merged into assistant)
    if (msg.role === "user") return hasContent;
    return hasContent || hasEvents;
  }), [messages]);

  // Counted once for the whole list — see `userMessageOrdinals` for why the
  // obvious per-row form is the thing that makes a long transcript unusable.
  const userOrdinals = useMemo(() => userMessageOrdinals(filtered), [filtered]);

  // The approval card + "thinking…" indicator ride at the end, inside the scrolled
  // content so stick-to-bottom keeps them in view.
  const hasTrailing = !!pendingApproval || isStreaming;

  // Mirror the lib's scroll-element ref into state so effects/nav re-run when the
  // scroll container mounts late (it appears only after the loading screen).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef(el);
    setScrollEl(el);
  }, [scrollRef]);

  // File changes per turn, keyed by the index of the turn's last assistant message.
  //
  // `filtered` is a new array on every streamed token, so this must not re-aggregate
  // the whole transcript each time — diffing every edit in a long session at token
  // rate is far too slow. Completed turns are therefore cached by their last
  // message's identity, leaving only the in-flight turn to recompute.
  const turnChangeCache = useRef(new Map<string, TurnFileChange[]>());
  const turnChanges = useMemo(() => {
    const cache = turnChangeCache.current;
    const out = new Map<number, TurnFileChange[]>();
    for (let i = 0; i < filtered.length; i++) {
      const msg = filtered[i]!;
      if (msg.role !== "assistant" || filtered[i + 1]?.role === "assistant") continue;
      const key = `${msg.id}:${msg.events?.length ?? 0}`;
      let changes = cache.get(key);
      if (!changes) {
        changes = aggregateTurnFileChanges(collectTurnMessages(filtered, i));
        cache.set(key, changes);
      }
      if (changes.length > 0) out.set(i, changes);
    }
    return out;
  }, [filtered]);

  // Jump from a change-tray row to the tool card that made the edit. The returned
  // cleanup clears the pending flash, so a second jump can't leave a stale highlight.
  const flashCleanupRef = useRef<(() => void) | null>(null);
  const handleJumpToEdit = useCallback((editRef: string) => {
    if (!scrollEl) return;
    flashCleanupRef.current?.();
    flashCleanupRef.current = jumpToEdit(scrollEl, editRef);
  }, [scrollEl]);
  useEffect(() => () => flashCleanupRef.current?.(), []);

  // Preserve the viewport when older messages are prepended (compact expand): capture
  // distance-from-bottom before the prepend, restore scrollTop after so the content
  // being read doesn't jump. Only fires for prepends — streaming appends leave the
  // ref null, so this is a no-op during normal streaming.
  // Declared above the scroll-preserving layout effect below, which reads
  // `autoLoadingCompact` to know whether the skeleton is still occupying space.
  const [autoLoadingCompact, setAutoLoadingCompact] = useState(false);
  // A failed expand used to be invisible: the fetch rejected, nothing caught it,
  // and scrolling to the top of a long chat simply did nothing forever. Holding
  // the reason both shows it and stops the loader retrying on every intersection.
  const [compactLoadError, setCompactLoadError] = useState<string | null>(null);

  const preserveFromBottomRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollEl;
    if (el && preserveFromBottomRef.current != null) {
      el.scrollTop = el.scrollHeight - preserveFromBottomRef.current;
      // Held, not cleared, while the skeleton is up: it occupies real space at
      // the top, so it moves `scrollHeight` without `filtered.length` changing.
      // Clearing here would leave the view jumped by the skeleton's height for
      // as long as the fetch takes, then jumped back when it resolved.
      if (!autoLoadingCompact) preserveFromBottomRef.current = null;
    }
  }, [filtered.length, scrollEl, autoLoadingCompact]);

  // Jump to the newest message when the conversation/session swaps (initial mount is
  // handled by `initial: "instant"`). Keyed on sessionId — NOT on filtered[0].id,
  // which also changes on compact prepend and would fight the prepend-preserve above.
  useLayoutEffect(() => {
    if (scrollEl) scrollToBottom({ animation: "instant" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scrollEl]);

  // Tabs are reparented (TabPool), not remounted, and hidden tabs are display:none.
  // While hidden the scroll container is 0-height, which use-stick-to-bottom reads as
  // "near bottom" and silently re-locks (escapedFromLock→false). Returning to a tab
  // mid-stream then follows to the bottom, losing the spot the user was reading.
  //
  // Guard: remember the user's real follow-intent captured ONLY while the panel is
  // visible (0-height readings are ignored), then on reshow re-assert "not following"
  // so TabPool's restored scroll position sticks instead of snapping to bottom.
  const followIntentRef = useRef(true);
  useEffect(() => {
    if (scrollEl && scrollEl.clientHeight > 0) followIntentRef.current = isAtBottom;
  }, [isAtBottom, scrollEl]);
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    let lastHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      const reshown = lastHeight === 0 && h > 0;
      lastHeight = h;
      // Cancel the lib's reshow-follow synchronously (before its rAF tick) — setting
      // isAtBottom=false makes its queued scrollToBottom abort.
      if (reshown && !followIntentRef.current) stopScroll();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollEl, stopScroll]);

  // Stable fork handler — avoids new closure per message (preserves MessageBubble memo)
  const handleFork = useCallback((msgContent: string, msgId: string | undefined) => {
    onFork?.(msgContent, msgId);
  }, [onFork]);

  // Stable edit handler — same-tab edit (preserves MessageBubble memo)
  const handleEdit = useCallback((msgContent: string, msgId: string | undefined, ownMsgId?: string) => {
    onEdit?.(msgContent, msgId, ownMsgId);
  }, [onEdit]);

  // Stable dismiss handler — avoids new closure per message (preserves MessageBubble memo)
  const handleDismiss = useCallback((msgId: string) => {
    onDismissMessage?.(msgId);
  }, [onDismissMessage]);

  const errorCount = useMemo(
    () => filtered.reduce((n, m) => (m.role === "system" ? n + 1 : n), 0),
    [filtered],
  );

  // Indices of user messages — powers the up/down message navigation buttons.
  const userIndices = useMemo(
    () => filtered.reduce<number[]>((acc, m, i) => { if (m.role === "user") acc.push(i); return acc; }, []),
    [filtered],
  );

  // Find the topmost message that has an unexpanded compact JSONL path.
  const findTopUnexpandedCompact = useCallback((): { id: string; jsonlPath: string } | null => {
    if (!onExpandCompact || !isCompactExpanded) return null;
    for (const msg of filtered) {
      if (isCompactExpanded(msg.id)) continue;
      // Check user message content for JSONL path
      const path = extractJsonlPath(msg.content || "");
      if (path) return { id: msg.id, jsonlPath: path };
      // Check assistant events for JSONL path
      if (msg.events) {
        for (const ev of msg.events) {
          if (ev.type === "text") {
            const evPath = extractJsonlPath(ev.content || "");
            if (evPath) return { id: msg.id, jsonlPath: evPath };
          }
        }
      }
    }
    return null;
  }, [filtered, onExpandCompact, isCompactExpanded]);

  const topUnexpandedCompact = findTopUnexpandedCompact();
  const hasMore = !!topUnexpandedCompact;

  // Held as two strings rather than as the object. `findTopUnexpandedCompact`
  // runs on every render and answers with a fresh literal, so depending on that
  // object made `loadMore` new every render — and the observer effect below
  // tore the IntersectionObserver down and built another one with it, which
  // during streaming is every token batch. Measured before: 1 observer at
  // mount, +1 per re-render against an unchanged message list.
  const topCompactId = topUnexpandedCompact?.id ?? null;
  const topCompactPath = topUnexpandedCompact?.jsonlPath ?? null;

  // Fetch pre-compact history from the server (prepends older messages).
  const loadMore = useCallback(async () => {
    if (!topCompactId || !topCompactPath || !onExpandCompact || autoLoadingCompact) return;
    // Capture distance-from-bottom so the post-prepend layout effect can hold the
    // reading position steady while older messages are inserted above.
    const el = scrollEl;
    preserveFromBottomRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setAutoLoadingCompact(true);
    setCompactLoadError(null);
    try {
      await onExpandCompact(topCompactId, topCompactPath);
    } catch (e) {
      setCompactLoadError(e instanceof Error ? e.message : "Could not load previous conversation");
    } finally {
      setAutoLoadingCompact(false);
    }
  }, [topCompactId, topCompactPath, onExpandCompact, autoLoadingCompact, scrollEl]);

  // Lazy-load older history when a sentinel at the top of the transcript comes
  // into range. This replaces a scroll listener that re-ran its check on every
  // scroll event and — the part that actually failed — could not fire at all
  // when the loaded history was shorter than the viewport, because there was
  // nothing to scroll. `loadMore` guards on `autoLoadingCompact`, so repeat
  // intersections while a fetch is in flight are free.
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollEl;
    const sentinel = topSentinelRef.current;
    if (!el || !sentinel || !hasMore || compactLoadError) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); },
      // Start the fetch while the top is still a screenful away, so the next
      // segment is usually there before the user reaches the end of this one.
      { root: el, rootMargin: "400px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollEl, hasMore, compactLoadError, loadMore]);

  if (messagesLoading && (!keepStaleWhileLoading || messages.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <Bot className="size-10 text-text-subtle animate-pulse" />
        <p className="text-sm">Loading messages...</p>
      </div>
    );
  }

  if (messages.length === 0 && !isStreaming) {
    return (
      <ChatWelcome
        projectName={projectName || ""}
        onSelectSession={onSelectSession || (() => {})}
      />
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden flex flex-col min-h-0">
      <TaskTracker projectName={projectName} sessionId={sessionId} messages={messages} />
      {errorCount > 1 && onClearErrors && (
        <div className="absolute top-2 left-0 right-0 z-20 flex justify-center pointer-events-none">
          <button
            type="button"
            onClick={onClearErrors}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-error/15 border border-error/25 px-3 py-1 text-xs text-error hover:bg-error/25 shadow-md backdrop-blur-sm"
          >
            <XCircle className="size-3.5" />
            Clear all errors ({errorCount})
          </button>
        </div>
      )}
      {!autoLoadingCompact && compactLoadError && (
        <div className="absolute top-2 left-0 right-0 z-10 flex justify-center">
          <button
            type="button"
            onClick={() => { setCompactLoadError(null); loadMore(); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-primary hover:bg-surface-hover min-h-[44px] md:min-h-0"
          >
            <AlertCircle className="size-3.5 text-destructive" />
            <span>Could not load previous conversation: {compactLoadError}</span>
            <span className="underline">Retry</span>
          </button>
        </div>
      )}
      <div
        ref={setScrollRef}
        {...{ [GALLERY_ROOT_ATTR]: "" }}
        className="flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
        style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}
      >
        <div ref={contentRef as unknown as React.Ref<HTMLDivElement>} className="w-full">
          {hasMore && <div ref={topSentinelRef} aria-hidden className="h-px" />}
          {autoLoadingCompact && <PreCompactSkeleton />}
          {filtered.map((msg, globalIdx) => {
            const prevMsg = globalIdx > 0 ? filtered[globalIdx - 1] : undefined;
            // User-message ordinal (1-based) — stable version-group anchor across forks.
            const versionOrdinal = userOrdinals[globalIdx] ?? 0;
            // Resolved here rather than deeper down so the ordinal→group lookup
            // happens once per message instead of being threaded through bubbles.
            const versionGroup = versionOrdinal ? versionMap?.[versionOrdinal] : undefined;
            // Highlight the user message armed for edit (matched by its own id).
            const isEditing = msg.role === "user" && editingMsgId != null && msg.id === editingMsgId;
            // An assistant turn spans multiple consecutive assistant messages (text +
            // tool segments). Show the action bar only on the last one of the run.
            const nextMsg = filtered[globalIdx + 1];
            const isLastAssistantInTurn = msg.role === "assistant" && nextMsg?.role !== "assistant";
            // Copy gathers the whole turn: walk back over consecutive assistant
            // messages and join their visible text (tool-only segments contribute nothing).
            let turnCopyText: string | undefined;
            if (isLastAssistantInTurn) {
              const parts: string[] = [];
              for (let j = globalIdx; j >= 0 && filtered[j]!.role === "assistant"; j--) {
                const t = assistantMessageText(filtered[j]!);
                if (t) parts.unshift(t);
              }
              turnCopyText = parts.join("\n\n");
            }
            return (
              <div
                key={msg.id}
                data-msg-index={globalIdx}
                className="px-4 pt-4 select-none"
              >
                <RenderErrorBoundary fallbackContent={msg.content}>
                  <MessageBubble
                    message={msg}
                    isStreaming={isStreaming && msg.id.startsWith("streaming-")}
                    isLastAssistantInTurn={isLastAssistantInTurn}
                    turnCopyText={turnCopyText}
                    turnChanges={isLastAssistantInTurn ? turnChanges.get(globalIdx) : undefined}
                    onJumpToEdit={handleJumpToEdit}
                    projectName={projectName}
                    onFork={msg.role === "user" && onFork ? handleFork : undefined}
                    onEdit={msg.role === "user" && onEdit ? handleEdit : undefined}
                    isEditing={isEditing}
                    onDismiss={msg.role === "system" && onDismissMessage ? handleDismiss : undefined}
                    prevMsgId={prevMsg?.sdkUuid ?? prevMsg?.id}
                    sessionId={sessionId}
                    providerId={providerId}
                    versionGroup={versionGroup}
                    onNavigateVersion={onNavigateVersion}
                    versionNavDisabled={isStreaming}
                    bashPartialOutput={bashPartialOutput}
                  />
                </RenderErrorBoundary>
              </div>
            );
          })}
          {hasTrailing && (
            <div className="px-4 pt-4 pb-4 space-y-4 select-none">
              {pendingApproval && (
                pendingApproval.tool === "AskUserQuestion"
                  ? <AskUserQuestionCard approval={pendingApproval} onRespond={onApprovalResponse} />
                  : <ApprovalCard approval={pendingApproval} onRespond={onApprovalResponse} />
              )}
              {isStreaming && <ThinkingIndicator lastMessage={messages[messages.length - 1]} phase={phase} elapsed={connectingElapsed} statusMessage={compactStatus === "compacting" ? "Compacting messages..." : statusMessage} />}
            </div>
          )}
        </div>
      </div>
      <ChatScrollNav scrollElement={scrollEl} userIndices={userIndices} scrollToBottom={scrollToBottom} />
    </div>
  );
}

/** Visible assistant text of a single message — text events only (skips tool cards),
 *  falling back to raw content when there are no events. */
function assistantMessageText(msg: ChatMessage): string {
  return msg.events?.length
    ? msg.events.filter((e) => e.type === "text").map((e) => e.content).join("")
    : msg.content;
}

const MessageBubble = memo(function MessageBubble({ message, isStreaming, isLastAssistantInTurn, turnCopyText, turnChanges, onJumpToEdit, projectName, onFork, onEdit, isEditing, onDismiss, prevMsgId, sessionId, providerId, versionGroup, onNavigateVersion, versionNavDisabled, bashPartialOutput }: {
  message: ChatMessage; isStreaming: boolean; isLastAssistantInTurn?: boolean; turnCopyText?: string; projectName?: string;
  /** Files this turn changed — drives the action-bar change pill. */
  turnChanges?: TurnFileChange[];
  onJumpToEdit?: (editRef: string) => void;
  onFork?: (content: string, messageId: string | undefined) => void;
  onEdit?: (content: string, messageId: string | undefined, ownMsgId?: string) => void;
  isEditing?: boolean;
  onDismiss?: (messageId: string) => void;
  prevMsgId?: string;
  sessionId?: string;
  providerId?: string;
  versionGroup?: VersionGroup;
  onNavigateVersion?: (sessionId: string) => void;
  versionNavDisabled?: boolean;
  bashPartialOutput?: React.RefObject<Map<string, BashPartialEntry>>;
}) {
  if (message.role === "user") {
    const handleFork = onFork ? () => onFork(message.content, prevMsgId) : undefined;
    const handleEdit = onEdit ? () => onEdit(message.content, prevMsgId, message.id) : undefined;
    return (
      <UserBubble
        content={message.content}
        messageId={message.id}
        timestamp={message.timestamp}
        projectName={projectName}
        onFork={handleFork}
        onEdit={handleEdit}
        isEditing={isEditing}
        sessionId={sessionId}
        providerId={providerId}
        versionGroup={versionGroup}
        onNavigateVersion={onNavigateVersion}
        versionNavDisabled={versionNavDisabled}
      />
    );
  }

  if (message.role === "system") {
    return (
      <div className="group flex items-center gap-2 rounded-lg bg-error/10 border border-error/20 px-3 py-2 text-sm text-error">
        <AlertCircle className="size-4 shrink-0" />
        <p className="flex-1">{message.content}</p>
        {onDismiss && (
          <button
            type="button"
            onClick={() => onDismiss(message.id)}
            aria-label="Dismiss"
            title="Dismiss"
            className="shrink-0 rounded p-1 text-error/70 hover:text-error hover:bg-error/15 md:opacity-0 md:group-hover:opacity-100"
          >
            <XCircle className="size-4" />
          </button>
        )}
      </div>
    );
  }

  // Assistant message — render events in order (text interleaved with tool calls)
  return (
    <div className="flex flex-col gap-2">
      {message.events && message.events.length > 0
        ? <InterleavedEvents events={message.events} isStreaming={isStreaming} projectName={projectName} bashPartialOutput={bashPartialOutput} />
        : message.content && (
            <div className="text-sm text-text-primary select-text">
              <MarkdownContent content={message.content} projectName={projectName} />
            </div>
          )}
      {/* Cost notice sits above the action bar so it reads as part of the finished turn */}
      {!isStreaming && isLastAssistantInTurn && message.usage && (
        <TurnCostWarning usage={message.usage} />
      )}
      {/* Action bar: only on the last assistant message of the turn, after streaming ends */}
      {!isStreaming && isLastAssistantInTurn && (
        <TurnChangeRollup
          timestamp={message.timestamp}
          content={turnCopyText ?? assistantMessageText(message)}
          changes={turnChanges}
          onJumpToEdit={onJumpToEdit}
        />
      )}
    </div>
  );
});






/* ToolCard, ToolSummary, ToolDetails extracted to ./tool-cards.tsx */

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: { requestId: string; tool: string; input: unknown };
  onRespond: (requestId: string, approved: boolean, data?: unknown) => void;
}) {
  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <ShieldAlert className="size-4" />
        <span>Tool Approval Required</span>
      </div>
      <div className="text-xs text-text-primary">
        <span className="font-medium">{approval.tool}</span>
      </div>
      <pre className="text-xs font-mono text-text-secondary overflow-x-auto bg-background rounded p-2 border border-border">
        {JSON.stringify(approval.input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={() => onRespond(approval.requestId, true)}
          className="px-4 py-1.5 rounded bg-success text-white text-xs font-medium hover:bg-success/80 transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond(approval.requestId, false)}
          className="px-4 py-1.5 rounded bg-error text-white text-xs font-medium hover:bg-error/80 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/** Interactive quiz form for AskUserQuestion — renders questions with selectable options + Other */
function AskUserQuestionCard({
  approval,
  onRespond,
}: {
  approval: { requestId: string; tool: string; input: unknown };
  onRespond: (requestId: string, approved: boolean, data?: unknown) => void;
}) {
  const input = approval.input as { questions?: Question[] };
  const questions = input.questions ?? [];

  return (
    <QuestionCard
      questions={questions}
      onSubmit={(answers) => onRespond(approval.requestId, true, answers)}
      onSkip={() => onRespond(approval.requestId, false)}
    />
  );
}
