import { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect, memo, lazy, Suspense } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { getAuthToken } from "@/lib/api-client";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import type { SessionPhase } from "../../../types/api";
import type { BashPartialEntry } from "../../hooks/use-chat";
import { ToolCard } from "./tool-cards";
import { TaskTracker } from "./task-tracker";
import { extractJsonlPath } from "./pre-compact-button";
// Kick off the markdown chunk fetch at module load (not first render): Suspense
// skeletons that resolve *after* the list mounts grow each message and shove the
// bottom of the transcript out of view on fresh load.
const markdownRendererImport = import("@/components/shared/markdown-renderer");
const MarkdownRenderer = lazy(() =>
  markdownRendererImport.then((m) => ({ default: m.MarkdownRenderer }))
);
import { cn, basename } from "@/lib/utils";
import { RenderErrorBoundary } from "@/components/shared/markdown-error-boundary";

import {
  AlertCircle,
  ShieldAlert,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Copy,
  Check,
  CheckCircle2,
  Loader2,
  RotateCcw,
  TerminalSquare,
  ChevronUp,
  Tag,
  XCircle,
  ExternalLink,
  Slash,
  Pencil,
} from "lucide-react";
import { ChatWelcome } from "./chat-welcome";
import { MessageActionBar, ActionButton } from "./message-action-bar";
import { VersionSwitcher } from "./version-switcher";
import { QuestionCard } from "./question-card";
import type { Question } from "./question-card";
import { useTabStore } from "@/stores/tab-store";
import { api } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import { useImageOverlay } from "@/stores/image-overlay-store";

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

  // Preserve the viewport when older messages are prepended (compact expand): capture
  // distance-from-bottom before the prepend, restore scrollTop after so the content
  // being read doesn't jump. Only fires for prepends — streaming appends leave the
  // ref null, so this is a no-op during normal streaming.
  const preserveFromBottomRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollEl;
    if (el && preserveFromBottomRef.current != null) {
      el.scrollTop = el.scrollHeight - preserveFromBottomRef.current;
      preserveFromBottomRef.current = null;
    }
  }, [filtered.length, scrollEl]);

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

  // Fetch pre-compact history from the server (prepends older messages).
  const [autoLoadingCompact, setAutoLoadingCompact] = useState(false);
  const loadMore = useCallback(async () => {
    if (!topUnexpandedCompact || !onExpandCompact || autoLoadingCompact) return;
    // Capture distance-from-bottom so the post-prepend layout effect can hold the
    // reading position steady while older messages are inserted above.
    const el = scrollEl;
    preserveFromBottomRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setAutoLoadingCompact(true);
    try {
      await onExpandCompact(topUnexpandedCompact.id, topUnexpandedCompact.jsonlPath);
    } finally {
      setAutoLoadingCompact(false);
    }
  }, [topUnexpandedCompact, onExpandCompact, autoLoadingCompact, scrollEl]);

  // Auto-load older history when the user scrolls near the top.
  useEffect(() => {
    const el = scrollEl;
    if (!el || !hasMore) return;
    const onScroll = () => { if (el.scrollTop < 200 && !autoLoadingCompact) loadMore(); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollEl, hasMore, autoLoadingCompact, loadMore]);

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
      {autoLoadingCompact && (
        <div className="absolute top-2 left-0 right-0 z-10 flex items-center justify-center gap-1.5 text-xs text-text-secondary pointer-events-none">
          <Loader2 className="size-3 animate-spin" />
          Loading previous conversation...
        </div>
      )}
      <div
        ref={setScrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
        style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}
      >
        <div ref={contentRef as unknown as React.Ref<HTMLDivElement>} className="w-full">
          {filtered.map((msg, globalIdx) => {
            const prevMsg = globalIdx > 0 ? filtered[globalIdx - 1] : undefined;
            // User-message ordinal (1-based) — stable version-group anchor across forks.
            const versionOrdinal = msg.role === "user"
              ? filtered.slice(0, globalIdx + 1).reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0)
              : 0;
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
                    projectName={projectName}
                    onFork={msg.role === "user" && onFork ? handleFork : undefined}
                    onEdit={msg.role === "user" && onEdit ? handleEdit : undefined}
                    isEditing={isEditing}
                    onDismiss={msg.role === "system" && onDismissMessage ? handleDismiss : undefined}
                    prevMsgId={prevMsg?.sdkUuid ?? prevMsg?.id}
                    sessionId={sessionId}
                    providerId={providerId}
                    versionOrdinal={versionOrdinal}
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
      <ScrollNavButtons scrollElement={scrollEl} userIndices={userIndices} scrollToBottom={scrollToBottom} />
    </div>
  );
}

/**
 * Floating bottom-right navigation between the user's own messages. Every bubble is
 * now in the real DOM (no virtualization), so navigation queries the rendered rows by
 * their `data-msg-index` and scrolls to the target. Up jumps to the nearest user
 * message above the top of the viewport; Down jumps to the nearest one below, or to
 * the very bottom when none remain.
 */
function ScrollNavButtons({ scrollElement, userIndices, scrollToBottom }: {
  scrollElement: HTMLDivElement | null;
  userIndices: number[];
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void | Promise<boolean> | boolean;
}) {
  const [hasAbove, setHasAbove] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  // Top of a row in the scroll container's content coordinates (scrollTop space).
  const rowTop = (el: HTMLElement, row: HTMLElement) =>
    row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;

  const userRows = useCallback((el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLElement>("[data-msg-index]"))
      .filter((r) => userIndices.includes(Number(r.dataset.msgIndex))),
    [userIndices]);

  useEffect(() => {
    const el = scrollElement;
    if (!el) return;
    let raf = 0;
    const recompute = () => {
      const top = el.scrollTop;
      const above = userRows(el).some((r) => rowTop(el, r) < top - 4);
      setHasAbove((prev) => (prev === above ? prev : above));
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      setAtBottom((prev) => (prev === bottom ? prev : bottom));
    };
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    recompute();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [scrollElement, userRows]);

  const goUp = useCallback(() => {
    const el = scrollElement;
    if (!el) return;
    const top = el.scrollTop;
    let target: number | undefined;
    for (const r of userRows(el)) {
      const t = rowTop(el, r);
      if (t < top - 4) target = t; // ascending — keep the last one still above
      else break;
    }
    if (target != null) el.scrollTo({ top: target, behavior: "auto" });
  }, [scrollElement, userRows]);

  const goDown = useCallback(() => {
    const el = scrollElement;
    if (!el) return;
    const top = el.scrollTop;
    const next = userRows(el).map((r) => rowTop(el, r)).find((t) => t > top + 4);
    if (next != null) el.scrollTo({ top: next, behavior: "auto" });
    else scrollToBottom({ animation: "instant" });
  }, [scrollElement, userRows, scrollToBottom]);

  const btnClass =
    "size-8 flex items-center justify-center rounded-full bg-surface-elevated/60 border border-border/60 text-text-secondary shadow-md backdrop-blur-sm transition-all hover:bg-surface-elevated hover:text-foreground disabled:opacity-30 disabled:cursor-default disabled:hover:bg-surface-elevated/60 disabled:hover:text-text-secondary";

  return (
    <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-2">
      <button type="button" onClick={goUp} disabled={!hasAbove} aria-label="Jump to previous message" className={btnClass}>
        <ChevronUp className="size-4" />
      </button>
      <button type="button" onClick={goDown} disabled={atBottom} aria-label="Jump to next message" className={btnClass}>
        <ChevronDown className="size-4" />
      </button>
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

const MessageBubble = memo(function MessageBubble({ message, isStreaming, isLastAssistantInTurn, turnCopyText, projectName, onFork, onEdit, isEditing, onDismiss, prevMsgId, sessionId, providerId, versionOrdinal, onNavigateVersion, versionNavDisabled, bashPartialOutput }: {
  message: ChatMessage; isStreaming: boolean; isLastAssistantInTurn?: boolean; turnCopyText?: string; projectName?: string;
  onFork?: (content: string, messageId: string | undefined) => void;
  onEdit?: (content: string, messageId: string | undefined, ownMsgId?: string) => void;
  isEditing?: boolean;
  onDismiss?: (messageId: string) => void;
  prevMsgId?: string;
  sessionId?: string;
  providerId?: string;
  versionOrdinal?: number;
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
        versionOrdinal={versionOrdinal}
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
      {/* Action bar: only on the last assistant message of the turn, after streaming ends */}
      {!isStreaming && isLastAssistantInTurn && (
        <MessageActionBar
          timestamp={message.timestamp}
          content={turnCopyText ?? assistantMessageText(message)}
          accountLabel={message.accountLabel}
          className="-mt-1.5"
        />
      )}
    </div>
  );
});

/** Image extensions that can be previewed inline */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

interface SystemTag {
  name: string;
  label: string;
  content: string;
}

const TAG_LABELS: Record<string, string> = {
  "system-reminder": "Context",
  "claudeMd": "CLAUDE.md",
  "gitStatus": "Git Status",
  "currentDate": "Date",
  "fast_mode_info": "Fast Mode",
  "available-deferred-tools": "Tools",
  "task-notification": "Task Result",
  "environment_details": "Environment",
  "local-command-caveat": "System",
};

/** Extract system-injected XML tags into structured objects + clean text */
function extractSystemTags(text: string): { cleanText: string; tags: SystemTag[] } {
  const tags: SystemTag[] = [];
  const tagPattern = /<(system-reminder|available-deferred-tools|antml:[\w-]+|fast_mode_info|claudeMd|gitStatus|currentDate|task-notification|environment_details|local-command-caveat)[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const name = match[1]!;
    tags.push({
      name,
      label: TAG_LABELS[name] ?? name.replace(/^antml:/, "").replace(/-/g, " "),
      content: match[2]!.trim(),
    });
  }
  const cleanText = text.replace(tagPattern, "").trim();
  return { cleanText, tags };
}

/** Extract slash command tags from user message content */
interface SlashCommand {
  name: string;
  args?: string;
}
function parseCommandTags(text: string): { command: SlashCommand | null; cleanText: string } {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!nameMatch) return { command: null, cleanText: text };
  const name = nameMatch[1]!.trim();
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch?.[1]?.trim() || undefined;
  // Strip all command tags regardless of order
  const cleanText = text
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .trim();
  return { command: { name, args }, cleanText };
}

/** Extract the IDE-injected <ide_opened_file> context tag — returns the open file path + cleaned text */
function parseIdeOpenedFile(text: string): { idePath: string | null; cleanText: string } {
  const tagRe = /<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g;
  const m = tagRe.exec(text);
  if (!m) return { idePath: null, cleanText: text };
  // Inner format: "The user opened the file <path> in the IDE. ..."
  const pathMatch = m[1]!.match(/opened the file (.+?) in the IDE/);
  const idePath = pathMatch?.[1]?.trim() ?? null;
  const cleanText = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "").trim();
  return { idePath, cleanText };
}

/** Parse user message content, extracting attached file paths and the actual text */
function parseUserAttachments(content: string): { files: string[]; text: string } {
  // Match: [Attached file: /path] or [Attached files:\n/path1\n/path2\n]
  const singleMatch = content.match(/^\[Attached file: (.+?)\]\n\n?/);
  if (singleMatch) {
    return { files: [singleMatch[1]!], text: content.slice(singleMatch[0].length) };
  }

  const multiMatch = content.match(/^\[Attached files:\n([\s\S]+?)\]\n\n?/);
  if (multiMatch) {
    const files = multiMatch[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    return { files, text: content.slice(multiMatch[0].length) };
  }

  return { files: [], text: content };
}

/** Build a preview URL for an uploaded file (served from /chat/uploads/:filename) */
function uploadPreviewUrl(filePath: string, projectName?: string): string {
  const filename = basename(filePath);
  // Use a generic project name — the upload route is project-scoped but files are global
  return `/api/project/${encodeURIComponent(projectName ?? "_")}/chat/uploads/${encodeURIComponent(filename)}`;
}

/** Check if a file path is an image based on extension */
function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(path.slice(dot).toLowerCase());
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/** Detect if tags contain system-injected content (not real user input) */
const SYSTEM_TAG_NAMES = new Set(["task-notification", "environment_details", "local-command-caveat"]);

/** Extract leading terminal code fences from message text */
function extractTerminalBlocks(text: string): { blocks: string[]; remainingText: string } {
  const blocks: string[] = [];
  let remaining = text;
  const re = /^```(?:bash|sh|shell|zsh)\n([\s\S]*?)\n```\s*(?:\n\n?)?/;
  let match;
  while ((match = remaining.match(re)) !== null) {
    blocks.push(match[1]!);
    remaining = remaining.slice(match[0].length);
  }
  return { blocks, remainingText: remaining.trim() };
}

/** User message bubble — full width, collapsible, with system tag badges */
function UserBubble({ content, messageId, timestamp, projectName, onFork, onEdit, isEditing, sessionId, providerId, versionOrdinal, onNavigateVersion, versionNavDisabled }: {
  content: string;
  messageId?: string;
  timestamp: string;
  projectName?: string;
  onFork?: () => void;
  onEdit?: () => void;
  isEditing?: boolean;
  sessionId?: string;
  providerId?: string;
  versionOrdinal?: number;
  onNavigateVersion?: (sessionId: string) => void;
  versionNavDisabled?: boolean;
}) {
  const { files, text, tags, command, terminalBlocks, idePath } = useMemo(() => {
    const { idePath, cleanText: afterIde } = parseIdeOpenedFile(content);
    const { blocks, remainingText: afterBlocks } = extractTerminalBlocks(afterIde);
    const parsed = parseUserAttachments(afterBlocks);
    // Strip local-command-stdout/stderr tags but keep their content as plain text
    const withoutCmdOutput = parsed.text
      .replace(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g, "$1");
    const { cleanText: noSysTags, tags } = extractSystemTags(withoutCmdOutput);
    const { command, cleanText } = parseCommandTags(noSysTags);
    const bodyText = command?.args
      ? (cleanText ? `${command.args}\n\n${cleanText}` : command.args)
      : cleanText;
    return { files: parsed.files, text: bodyText, tags, command, terminalBlocks: blocks, idePath };
  }, [content]);

  const isSystemContext = tags.some((t) => SYSTEM_TAG_NAMES.has(t.name));

  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => setIsOverflowing(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div className={cn("flex flex-col gap-1", !isSystemContext && "items-end")}>
    {/* Own-content bubble: accent-wash fill + custom radius (sharp bottom-right
        corner anchors it to the sender on the right). */}
    <div
      data-user-message={!isSystemContext ? "true" : undefined}
      style={!isSystemContext ? { borderRadius: "var(--rad) var(--rad) 4px var(--rad)" } : undefined}
      className={cn(
        "group/user relative px-3 py-2 text-sm border shadow-sm transition-all",
      isSystemContext
        ? "rounded-lg bg-surface/40 border-border/40 text-text-secondary"
        : "max-w-[80%] bg-accent-wash border-accent-wash-border text-text",
      isEditing && "ring-2 ring-primary/60 border-primary/40",
    )}>
      {/* System tags as badges */}
      {tags.length > 0 && <SystemTagBadges tags={tags} />}

      {/* Slash command chip — args rendered in body for expand/collapse support */}
      {command && (
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
            <Slash className="size-3 shrink-0" />
            {command.name}
          </span>
        </div>
      )}

      {/* IDE context — the file the user had open, as a clickable chip */}
      {idePath && (
        <div className="flex items-center gap-1.5 mb-1 text-[11px] text-text-subtle">
          <span className="shrink-0">Opened in IDE:</span>
          <FilePathChip path={idePath} projectName={projectName} />
        </div>
      )}

      {/* Attached files — image thumbnails + file chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((filePath, i) =>
            isImagePath(filePath) ? (
              <AuthImageThumbnail key={i} filePath={filePath} projectName={projectName} />
            ) : (
              <div
                key={i}
                className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] text-text-secondary"
              >
                <FileText className="size-3 shrink-0" />
                <span className="truncate max-w-32">{basename(filePath)}</span>
              </div>
            ),
          )}
        </div>
      )}

      {/* Terminal output previews */}
      {terminalBlocks.length > 0 && (
        <div className="space-y-1.5">
          {terminalBlocks.map((block, i) => (
            <TerminalBlockPreview key={i} content={block} />
          ))}
        </div>
      )}

      {/* Text content — 2-line clamp by default, expandable */}
      {text && (
        <div
          ref={contentRef}
          className={cn(
            "whitespace-pre-wrap break-words transition-all duration-200 select-text",
            !expanded && "line-clamp-2",
            expanded && "max-h-[50vh] overflow-y-auto",
          )}
        >
          {isSystemContext ? <TextWithFilePaths text={text} projectName={projectName} /> : text}
        </div>
      )}
      {(isOverflowing || expanded) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "flex items-center gap-1 text-xs mt-1 transition-colors",
            isSystemContext ? "text-text-subtle hover:text-text-secondary" : "text-primary/70 hover:text-primary",
          )}
        >
          {expanded ? <><ChevronUp className="size-3" />Show less</> : <><ChevronDown className="size-3" />Show more</>}
        </button>
      )}
      {/* Version switcher — only when this message has edited siblings */}
      {!isSystemContext && onNavigateVersion && (
        <VersionSwitcher
          projectName={projectName}
          sessionId={sessionId}
          providerId={providerId ?? "claude"}
          ordinal={versionOrdinal}
          onNavigate={onNavigateVersion}
          disabled={versionNavDisabled}
        />
      )}
    </div>
      {/* Action bar below the bubble — timestamp, copy, edit/fork (real user messages only) */}
      {!isSystemContext && (
        <MessageActionBar timestamp={timestamp} content={content}>
          {onEdit && (
            <ActionButton
              icon={<Pencil className="size-3.5" />}
              label="Edit"
              title="Edit this message (continue in the same tab)"
              onClick={onEdit}
            />
          )}
          {onFork && (
            <ActionButton
              icon={<RotateCcw className="size-3.5" />}
              label="Fork"
              title="Retry from this message (fork into a new tab)"
              onClick={onFork}
            />
          )}
        </MessageActionBar>
      )}
    </div>
  );
}

/** Collapsible terminal output preview in user messages */
function TerminalBlockPreview({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
          expanded
            ? "border-primary/50 bg-surface-elevated text-text-primary"
            : "border-border/60 bg-background/40 text-text-secondary hover:bg-surface",
        )}
      >
        <TerminalSquare className="size-3.5 shrink-0" />
        <span>Terminal output</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-xs text-text-primary font-mono whitespace-pre-wrap break-words">
          {content}
        </pre>
      )}
    </div>
  );
}

/** Render system tags as collapsible badges */
function SystemTagBadges({ tags }: { tags: SystemTag[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag, i) => (
        <SystemTagBadge key={i} tag={tag} />
      ))}
    </div>
  );
}

function SystemTagBadge({ tag }: { tag: SystemTag }) {
  const [open, setOpen] = useState(false);

  // Task notification: render formatted instead of raw XML
  if (tag.name === "task-notification") {
    return <TaskNotificationBadge content={tag.content} />;
  }

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-full border border-border/60 bg-surface/50 px-2 py-0.5 text-text-subtle hover:text-text-secondary hover:bg-surface transition-colors"
      >
        <Tag className="size-2.5" />
        <span>{tag.label}</span>
        <ChevronRight className={cn("size-2.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 rounded border border-border/40 bg-surface/30 px-2 py-1.5 text-[11px] text-text-subtle/80 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
          {tag.content}
        </div>
      )}
    </div>
  );
}

/** Extract a sub-tag value from XML-like content */
function xmlTag(content: string, tag: string): string | undefined {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1]?.trim() || undefined;
}

/** Formatted badge for <task-notification> — shows status, summary, output file, result */
function TaskNotificationBadge({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const status = xmlTag(content, "status");
  const summary = xmlTag(content, "summary");
  const outputFile = xmlTag(content, "output-file");
  const result = xmlTag(content, "result");
  const isOk = status === "completed";

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/50 px-2 py-0.5 text-text-subtle hover:text-text-secondary hover:bg-surface transition-colors"
      >
        {isOk ? <CheckCircle2 className="size-2.5 text-success" /> : <XCircle className="size-2.5 text-warning" />}
        <span className="truncate max-w-80">{summary ?? "Task notification"}</span>
        <ChevronRight className={cn("size-2.5 transition-transform shrink-0", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 rounded border border-border/40 bg-surface/30 px-2 py-1.5 space-y-1.5">
          {/* Full summary (button truncates it) */}
          {summary && <p className="text-[11px] text-text-secondary">{summary}</p>}
          {outputFile && <FilePathChip path={outputFile} />}
          {result && (
            <div className="text-[11px] text-text-subtle/80 max-h-60 overflow-y-auto leading-relaxed">
              <MarkdownContent content={result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Clickable file path chip — opens file in editor tab */
function FilePathChip({ path, projectName }: { path: string; projectName?: string }) {
  const handleClick = useCallback(() => {
    const openTab = useTabStore.getState().openTab;
    const pName = projectName ?? useProjectStore.getState().activeProject?.name;
    const fileName = basename(path);
    const meta: Record<string, unknown> = { filePath: path };
    if (pName) meta.projectName = pName;
    // Try to verify file exists, then open; fallback: open directly
    api.get(`/api/fs/read?path=${encodeURIComponent(path)}`).then(() => {
      openTab({ type: "editor", title: fileName, metadata: meta, projectId: null, closable: true });
    }).catch(() => {
      openTab({ type: "editor", title: fileName, metadata: meta, projectId: null, closable: true });
    });
  }, [path, projectName]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded border border-border/50 bg-surface/50 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface transition-colors cursor-pointer"
    >
      <FileText className="size-2.5 shrink-0" />
      <span className="truncate max-w-60">{basename(path)}</span>
      <ExternalLink className="size-2 shrink-0 opacity-50" />
    </button>
  );
}

/** Render text with absolute file paths detected and turned into clickable chips */
function TextWithFilePaths({ text, projectName }: { text: string; projectName?: string }) {
  const parts = useMemo(() => {
    // Match absolute file paths (at least 2 segments)
    const re = /(\/(?:[\w.\-]+\/)+[\w.\-]+)/g;
    const result: { kind: "text" | "path"; value: string }[] = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) result.push({ kind: "text", value: text.slice(last, m.index) });
      result.push({ kind: "path", value: m[1]! });
      last = m.index + m[0].length;
    }
    if (last < text.length) result.push({ kind: "text", value: text.slice(last) });
    return result;
  }, [text]);

  return (
    <>
      {parts.map((p, i) =>
        p.kind === "path"
          ? <FilePathChip key={i} path={p.value} projectName={projectName} />
          : <span key={i}>{p.value}</span>,
      )}
    </>
  );
}

/**
 * Session-scoped image cache: blob URL + rendered box per src. Virtualized rows
 * unmount/remount constantly while scrolling; refetching the image and re-growing
 * from the placeholder on EVERY remount changed the row height after paint — the
 * repeatable downward jerk when scrolling up through image-bearing messages.
 * URLs are intentionally never revoked (bounded by unique images per session).
 */
const imageBlobCache = new Map<string, { url: string; w?: number; h?: number }>();

/** Hook: fetch an image via auth header, return blob URL (cached across mounts) */
function useAuthBlob(src: string): { blobUrl: string | null; error: boolean } {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => imageBlobCache.get(src)?.url ?? null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const cached = imageBlobCache.get(src);
    if (cached) { setBlobUrl(cached.url); return; }
    let stale = false;
    const token = getAuthToken();
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error("Failed"); return r.blob(); })
      .then((blob) => {
        if (stale) return;
        const url = URL.createObjectURL(blob);
        imageBlobCache.set(src, { url });
        setBlobUrl(url);
      })
      .catch(() => { if (!stale) setError(true); });
    return () => { stale = true; }; // cache owns the URL — no revoke
  }, [src]);

  return { blobUrl, error };
}

/** Fetches image with auth header, renders as blob URL — click opens lightbox */
function AuthImage({ src, alt }: { src: string; alt: string }) {
  const { blobUrl, error } = useAuthBlob(src);
  const openOverlay = useImageOverlay((s) => s.open);
  // Rendered box captured after the first load — pins the layout on remounts so
  // the row never grows after paint (see imageBlobCache).
  const cached = imageBlobCache.get(src);
  const box = cached?.w && cached?.h ? { width: cached.w, height: cached.h } : undefined;

  if (error) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary">
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="truncate max-w-40">{alt}</span>
      </div>
    );
  }

  if (!blobUrl) {
    return <div className="rounded-md bg-surface border border-border h-24 w-32 animate-pulse" style={box} />;
  }

  return (
    <button type="button" onClick={() => openOverlay(blobUrl, alt)} className="block text-left">
      <img
        src={blobUrl}
        alt={alt}
        style={box}
        onLoad={(e) => {
          const el = e.currentTarget;
          const c = imageBlobCache.get(src);
          if (c && (!c.w || !c.h)) { c.w = el.offsetWidth; c.h = el.offsetHeight; }
        }}
        className="rounded-md max-h-48 max-w-full object-contain border border-border cursor-pointer hover:opacity-90 transition-opacity"
      />
    </button>
  );
}

/** Chip for attached images in user bubble — tiny preview replaces icon, click opens lightbox */
function AuthImageThumbnail({ filePath, projectName }: { filePath: string; projectName?: string }) {
  const src = uploadPreviewUrl(filePath, projectName);
  const { blobUrl, error } = useAuthBlob(src);
  const openOverlay = useImageOverlay((s) => s.open);
  const name = basename(filePath);

  return (
    <button
      type="button"
      onClick={() => blobUrl && openOverlay(blobUrl, name)}
      className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface transition-colors cursor-pointer"
    >
      {blobUrl ? (
        <img src={blobUrl} alt={name} className="size-4 rounded-sm object-cover shrink-0" />
      ) : error ? (
        <ImageIcon className="size-3 shrink-0" />
      ) : (
        <div className="size-4 rounded-sm bg-surface animate-pulse shrink-0" />
      )}
      <span className="truncate max-w-32">{name}</span>
    </button>
  );
}

/** Fetches file with auth, opens in new browser tab (for PDFs, etc.) */
function AuthFileLink({ src, filename, mimeType }: { src: string; filename: string; mimeType: string }) {
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error("Failed to load");
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: mimeType }));
      window.open(url, "_blank");
      // Revoke after a delay to let the new tab load
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      // Fallback: try direct link
      window.open(src, "_blank");
    } finally {
      setLoading(false);
    }
  }, [src, mimeType]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50"
    >
      <FileText className="size-3.5 shrink-0 text-error" />
      <span className="truncate max-w-40">{filename}</span>
      {loading && <span className="animate-spin text-[10px]">...</span>}
    </button>
  );
}

/**
 * Renders events in order — consecutive text events merged into one bubble,
 * tool_use/tool_result render as cards between text sections.
 * Last text group shows streaming cursor when actively streaming.
 */
type EventGroup =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; tool: ChatEvent; result?: ChatEvent; completed?: boolean };

function InterleavedEvents({ events, isStreaming, projectName, bashPartialOutput }: {
  events: ChatEvent[];
  isStreaming: boolean;
  projectName?: string;
  bashPartialOutput?: React.RefObject<Map<string, BashPartialEntry>>;
}) {
  // Group: consecutive text → merged text block; tool_use + tool_result paired by toolUseId
  const groups: EventGroup[] = [];
  let textBuffer = "";

  // First pass: create groups for text, thinking, and tool_use events
  let thinkingBuffer = "";
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "thinking") {
      // Flush text buffer first if any
      if (textBuffer) { groups.push({ kind: "text", content: textBuffer }); textBuffer = ""; }
      thinkingBuffer += event.content;
      continue;
    }
    // Flush thinking buffer when non-thinking event arrives
    if (thinkingBuffer) {
      groups.push({ kind: "thinking", content: thinkingBuffer });
      thinkingBuffer = "";
    }
    if (event.type === "account_retry") {
      if (textBuffer) { groups.push({ kind: "text", content: textBuffer }); textBuffer = ""; }
      const label = (event as any).accountLabel ?? "another account";
      const reason = (event as any).reason ?? "Auth failed";
      groups.push({ kind: "text", content: `\n\n> ↻ ${reason} — retrying with **${label}**...\n\n` });
      continue;
    }
    if (event.type === "text") {
      textBuffer += event.content;
    } else if (event.type === "tool_use") {
      if (textBuffer) {
        groups.push({ kind: "text", content: textBuffer });
        textBuffer = "";
      }
      groups.push({ kind: "tool", tool: event });
    } else if (event.type === "tool_result") {
      // Skip tool_results in first pass — matched below
    } else {
      if (textBuffer) {
        groups.push({ kind: "text", content: textBuffer });
        textBuffer = "";
      }
      groups.push({ kind: "tool", tool: event });
    }
  }
  if (thinkingBuffer) {
    groups.push({ kind: "thinking", content: thinkingBuffer });
  }
  if (textBuffer) {
    groups.push({ kind: "text", content: textBuffer });
  }

  // Second pass: match tool_result events to their tool_use by toolUseId
  const toolResults = events.filter((e) => e.type === "tool_result");
  for (const tr of toolResults) {
    const trId = (tr as any).toolUseId;
    // Match by ID if available
    if (trId) {
      const match = groups.find(
        (g) => g.kind === "tool" && g.tool.type === "tool_use" && (g.tool as any).toolUseId === trId,
      ) as (EventGroup & { kind: "tool" }) | undefined;
      if (match) {
        match.result = tr;
        continue;
      }
    }
    // Fallback: attach to first tool group without a result
    const unmatched = groups.find(
      (g) => g.kind === "tool" && !g.result,
    ) as (EventGroup & { kind: "tool" }) | undefined;
    if (unmatched) {
      unmatched.result = tr;
    }
  }

  // Third pass: fallback to embedded result from buffer enrichment (reconnect).
  // When BE buffers tool_result, it also attaches result onto the matching tool_use event.
  for (const g of groups) {
    if (g.kind === "tool" && !g.result && g.tool.type === "tool_use") {
      const embedded = (g.tool as any).result;
      if (embedded) {
        g.result = { type: "tool_result", output: embedded.output, isError: embedded.isError } as ChatEvent;
      }
    }
  }

  // Mark tool groups without explicit tool_result as completed when:
  // 1. It's a Read and a later Edit on the same file has a result (Edit implies Read finished)
  // 2. Streaming is fully finished
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]!;
    if (g.kind === "tool" && !g.result) {
      let impliedDone = false;
      if (g.tool.type === "tool_use" && g.tool.tool === "Read") {
        const readPath = (g.tool.input as any)?.file_path;
        if (readPath) {
          impliedDone = groups.slice(gi + 1).some(
            (later) => later.kind === "tool" && later.result
              && later.tool.type === "tool_use" && later.tool.tool === "Edit"
              && (later.tool.input as any)?.file_path === readPath,
          );
        }
      }
      g.completed = impliedDone || !isStreaming;
    }
  }

  return (
    <>
      {groups.map((group, i) => {
        if (group.kind === "thinking") {
          return <ThinkingBlock key={`think-${i}`} content={group.content} isStreaming={isStreaming && i === groups.length - 1} />;
        }
        if (group.kind === "text") {
          const isLast = isStreaming && i === groups.length - 1;
          return (
            <div key={`text-${i}`} className="text-sm text-text-primary select-text">
              <StreamingText content={group.content} animate={isLast} projectName={projectName} />
            </div>
          );
        }
        return <ToolCard key={`tool-${i}`} tool={group.tool} result={group.result} completed={group.completed} projectName={projectName} bashPartialOutput={bashPartialOutput} />;
      })}
    </>
  );
}

/** Collapsible thinking block — shows Claude's reasoning, collapsed by default when done */
function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (!isStreaming && content.length > 0) setExpanded(false);
  }, [isStreaming, content.length]);

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (isStreaming && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, isStreaming, expanded]);

  return (
    <div className="rounded border border-border/50 bg-surface/30 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-surface transition-colors text-text-subtle"
      >
        {isStreaming ? <Loader2 className="size-3 animate-spin" /> : <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />}
        <span>Thinking{isStreaming ? "..." : ""}</span>
        {!isStreaming && <span className="text-text-subtle/50 ml-auto">{content.length > 100 ? `${Math.round(content.length / 4)} tokens` : ""}</span>}
      </button>
      {expanded && (
        <div ref={scrollRef} className="max-h-60 overflow-y-auto">
          <div className="px-2 pb-2 text-text-subtle/80 whitespace-pre-wrap text-[11px] leading-relaxed">
            {content}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Text component that renders streamed content directly.
 * WebSocket already delivers tokens incrementally — no fake animation needed.
 * When `isStreaming=true`, shows a blinking cursor at the end.
 */
function StreamingText({ content, animate: isStreaming, projectName }: { content: string; animate: boolean; projectName?: string }) {
  return (
    <>
      <MarkdownContent content={content} projectName={projectName} isStreaming={isStreaming} />
      {isStreaming && (
        <span className="text-text-subtle text-sm animate-pulse">Thinking...</span>
      )}
    </>
  );
}

/**
 * Shows streaming status with elapsed time and warnings:
 * - No assistant message: "Connecting to Claude..." with elapsed timer
 * - After tool: "Processing..."
 * - Text streaming: hidden
 */
function ThinkingIndicator({ lastMessage, phase, elapsed, statusMessage }: { lastMessage?: ChatMessage; phase?: SessionPhase; elapsed?: number; statusMessage?: string | null }) {
  // Show indicator when:
  // 1. No assistant message yet (waiting for first response)
  // 2. Last event is tool_result (Claude thinking after tool execution)
  // 3. statusMessage is active (account routing/refreshing)
  // Hide when text is actively streaming (text itself is the indicator)

  const isWaiting = !lastMessage || lastMessage.role !== "assistant";
  const isAfterTool = (() => {
    if (!lastMessage?.events?.length) return false;
    const last = lastMessage.events[lastMessage.events.length - 1]!;
    return last.type === "tool_result";
  })();

  if (!statusMessage && !isWaiting && !isAfterTool) return null;

  const label = statusMessage
    ? statusMessage
    : phase === "initializing" ? "Initializing"
    : phase === "connecting" ? "Connecting"
    : phase === "thinking" ? "Thinking"
    : "Processing";

  const isLong = phase === "connecting" && (elapsed ?? 0) >= 30;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2 text-text-subtle">
        <Loader2 className="size-3 animate-spin" />
        <span>
          {label}
          {isWaiting && (elapsed ?? 0) > 0 && <span className="text-text-subtle/60">... ({elapsed}s)</span>}
        </span>
      </div>
      {isLong && (
        <p className="text-xs text-warning/80 ml-5">
          Taking longer than usual — may be rate-limited or API slow. Try sending a new message to retry.
        </p>
      )}
    </div>
  );
}

/** Strip SDK teammate-message XML tags from text — team popover shows these */
const TEAMMATE_MSG_RE = /<teammate-message[^>]*>[\s\S]*?<\/teammate-message>/g;
function stripTeammateMessages(text: string): string {
  return text.replace(TEAMMATE_MSG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Wrapper: delegates to shared MarkdownRenderer with code actions enabled */
function MarkdownContent({ content, projectName, isStreaming }: { content: string; projectName?: string; isStreaming?: boolean }) {
  const cleaned = stripTeammateMessages(content);
  if (!cleaned) return null;
  return (
    <RenderErrorBoundary fallbackContent={cleaned}>
      <Suspense fallback={<div className="animate-pulse h-4 bg-muted rounded" />}>
        <MarkdownRenderer content={cleaned} projectName={projectName} codeActions isStreaming={isStreaming} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

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
