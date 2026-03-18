import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { getAuthToken } from "@/lib/api-client";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import type { StreamingStatus } from "@/hooks/use-chat";
import { ToolCard } from "./tool-cards";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { basename } from "@/lib/utils";

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
  Loader2,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";

interface MessageListProps {
  messages: ChatMessage[];
  messagesLoading?: boolean;
  pendingApproval: { requestId: string; tool: string; input: unknown } | null;
  onApprovalResponse: (requestId: string, approved: boolean, data?: unknown) => void;
  isStreaming: boolean;
  streamingStatus?: StreamingStatus;
  connectingElapsed?: number;
  thinkingWarningThreshold?: number;
  projectName?: string;
  /** Called when user clicks Fork/Rewind — opens new forked chat tab */
  onFork?: (userMessage: string) => void;
}

export function MessageList({
  messages,
  messagesLoading,
  pendingApproval,
  onApprovalResponse,
  isStreaming,
  streamingStatus,
  connectingElapsed,
  thinkingWarningThreshold,
  projectName,
  onFork,
}: MessageListProps) {
  // Scroll handled by StickToBottom wrapper — no manual scroll logic needed

  if (messagesLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <Bot className="size-10 text-text-subtle animate-pulse" />
        <p className="text-sm">Loading messages...</p>
      </div>
    );
  }

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <Bot className="size-10 text-text-subtle" />
        <p className="text-sm">Send a message to start the conversation</p>
      </div>
    );
  }

  return (
    <StickToBottom className="flex-1 overflow-y-auto" resize="smooth" initial="instant">
      <StickToBottom.Content className="p-4 space-y-4">
        {messages
          .filter((msg) => {
            const hasContent = msg.content && msg.content.trim().length > 0;
            const hasEvents = msg.events && msg.events.length > 0;
            return hasContent || hasEvents;
          })
          .map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isStreaming={isStreaming && msg.id.startsWith("streaming-")}
              projectName={projectName}
              onFork={msg.role === "user" && onFork ? () => onFork(msg.content) : undefined}
            />
          ))}

        {pendingApproval && (
          pendingApproval.tool === "AskUserQuestion"
            ? <AskUserQuestionCard approval={pendingApproval} onRespond={onApprovalResponse} />
            : <ApprovalCard approval={pendingApproval} onRespond={onApprovalResponse} />
        )}

        {isStreaming && <ThinkingIndicator lastMessage={messages[messages.length - 1]} streamingStatus={streamingStatus} elapsed={connectingElapsed} warningThreshold={thinkingWarningThreshold} />}
      </StickToBottom.Content>
      <ScrollToBottomButton />
    </StickToBottom>
  );
}

/** Floating button to scroll back to bottom when user has scrolled up */
function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      onClick={() => scrollToBottom()}
      className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1 rounded-full bg-surface-elevated border border-border text-xs text-text-secondary hover:text-foreground shadow-lg transition-all"
    >
      <ChevronDown className="size-3" />
      Scroll to bottom
    </button>
  );
}

function MessageBubble({ message, isStreaming, projectName, onFork }: { message: ChatMessage; isStreaming: boolean; projectName?: string; onFork?: () => void }) {
  if (message.role === "user") {
    return <UserBubble content={message.content} projectName={projectName} onFork={onFork} />;
  }

  if (message.role === "system") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
        <AlertCircle className="size-4 shrink-0" />
        <p>{message.content}</p>
      </div>
    );
  }

  // Assistant message — render events in order (text interleaved with tool calls)
  return (
    <div className="flex flex-col gap-2">
      {message.events && message.events.length > 0
        ? <InterleavedEvents events={message.events} isStreaming={isStreaming} projectName={projectName} />
        : message.content && (
            <div className="text-sm text-text-primary">
              <MarkdownContent content={message.content} projectName={projectName} />
            </div>
          )}
    </div>
  );
}

/** Image extensions that can be previewed inline */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

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

/** User message bubble with attachment rendering */
function UserBubble({ content, projectName, onFork }: { content: string; projectName?: string; onFork?: () => void }) {
  const { files, text } = useMemo(() => parseUserAttachments(content), [content]);

  return (
    <div className="flex justify-end group/user">
      <div className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-text-primary max-w-[85%] space-y-2 relative">
        {/* Attached files */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((filePath, i) =>
              isImagePath(filePath) ? (
                <AuthImage
                  key={i}
                  src={uploadPreviewUrl(filePath, projectName)}
                  alt={basename(filePath) || "image"}
                />
              ) : isPdfPath(filePath) ? (
                <AuthFileLink
                  key={i}
                  src={uploadPreviewUrl(filePath, projectName)}
                  filename={basename(filePath) || "document.pdf"}
                  mimeType="application/pdf"
                />
              ) : (
                <div
                  key={i}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary"
                >
                  <FileText className="size-3.5 shrink-0" />
                  <span className="truncate max-w-40">{basename(filePath)}</span>
                </div>
              ),
            )}
          </div>
        )}

        {/* Text content */}
        {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
        {/* Fork/Rewind button — visible on hover */}
        {onFork && (
          <button
            onClick={onFork}
            title="Retry from this message (fork session)"
            className="absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover/user:opacity-100 transition-opacity size-6 flex items-center justify-center rounded bg-surface border border-border text-text-subtle hover:text-text-primary hover:bg-surface-elevated"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Fetches image with auth header, renders as blob URL */
function AuthImage({ src, alt }: { src: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoke: string | undefined;
    const token = getAuthToken();
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        revoke = url;
        setBlobUrl(url);
      })
      .catch(() => setError(true));

    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [src]);

  if (error) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary">
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="truncate max-w-40">{alt}</span>
      </div>
    );
  }

  if (!blobUrl) {
    return <div className="rounded-md bg-surface border border-border h-24 w-32 animate-pulse" />;
  }

  return (
    <a href={blobUrl} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={blobUrl}
        alt={alt}
        className="rounded-md max-h-48 max-w-full object-contain border border-border"
      />
    </a>
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
      <FileText className="size-3.5 shrink-0 text-red-400" />
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

function InterleavedEvents({ events, isStreaming, projectName }: { events: ChatEvent[]; isStreaming: boolean; projectName?: string }) {
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
            <div key={`text-${i}`} className="text-sm text-text-primary">
              <StreamingText content={group.content} animate={isLast} projectName={projectName} />
            </div>
          );
        }
        return <ToolCard key={`tool-${i}`} tool={group.tool} result={group.result} completed={group.completed} projectName={projectName} />;
      })}
    </>
  );
}

/** Collapsible thinking block — shows Claude's reasoning, collapsed by default when done */
function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming);

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (!isStreaming && content.length > 0) setExpanded(false);
  }, [isStreaming, content.length]);

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
        <div className="px-2 pb-2 text-text-subtle/80 whitespace-pre-wrap max-h-60 overflow-y-auto text-[11px] leading-relaxed">
          {content}
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
      <MarkdownContent content={content} projectName={projectName} />
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
function ThinkingIndicator({ lastMessage, streamingStatus, elapsed, warningThreshold = 15 }: { lastMessage?: ChatMessage; streamingStatus?: StreamingStatus; elapsed?: number; warningThreshold?: number }) {
  // Show "Thinking" when:
  // 1. No assistant message yet (waiting for first response)
  // 2. Last event is tool_use/tool_result (Claude thinking after tool execution)
  // Hide when text is actively streaming (text itself is the indicator)

  const isWaiting = !lastMessage || lastMessage.role !== "assistant";
  // Show Thinking only after tool_result (tool finished), not tool_use (tool still running)
  const isAfterTool = (() => {
    if (!lastMessage?.events?.length) return false;
    const last = lastMessage.events[lastMessage.events.length - 1]!;
    return last.type === "tool_result";
  })();

  if (!isWaiting && !isAfterTool) return null;

  const isLong = isWaiting && (elapsed ?? 0) >= warningThreshold;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2 text-text-subtle">
        <Loader2 className="size-3 animate-spin" />
        <span>
          Thinking
          {isWaiting && (elapsed ?? 0) > 0 && <span className="text-text-subtle/60">... ({elapsed}s)</span>}
        </span>
      </div>
      {isLong && (
        <p className="text-xs text-yellow-500/80 ml-5">
          Taking longer than usual — may be rate-limited or API slow. Try sending a new message to retry.
        </p>
      )}
    </div>
  );
}

/** Wrapper: delegates to shared MarkdownRenderer with code actions enabled */
function MarkdownContent({ content, projectName }: { content: string; projectName?: string }) {
  return <MarkdownRenderer content={content} projectName={projectName} codeActions />;
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
    <div className="rounded-lg border-2 border-yellow-500/40 bg-yellow-500/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-yellow-400 text-sm font-medium">
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
          className="px-4 py-1.5 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-500 transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond(approval.requestId, false)}
          className="px-4 py-1.5 rounded bg-red-600 text-white text-xs font-medium hover:bg-red-500 transition-colors"
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
  const input = approval.input as {
    questions?: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
  const questions = input.questions ?? [];

  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Track which questions have "Other" active
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});

  const handleSelect = (question: string, label: string, multiSelect?: boolean) => {
    // Deactivate "Other" when selecting a predefined option
    setOtherActive((prev) => ({ ...prev, [question]: false }));
    setAnswers((prev) => {
      if (!multiSelect) return { ...prev, [question]: label };
      const current = prev[question] ?? "";
      const labels = current ? current.split(", ") : [];
      const idx = labels.indexOf(label);
      if (idx >= 0) labels.splice(idx, 1);
      else labels.push(label);
      return { ...prev, [question]: labels.join(", ") };
    });
  };

  const handleOtherToggle = (question: string) => {
    setOtherActive((prev) => ({ ...prev, [question]: true }));
    setAnswers((prev) => ({ ...prev, [question]: "" }));
  };

  const handleOtherText = (question: string, text: string) => {
    setAnswers((prev) => ({ ...prev, [question]: text }));
  };

  const allAnswered = questions.every((q) => answers[q.question]?.trim());

  return (
    <div className="rounded-lg border-2 border-accent/40 bg-accent/5 p-3 space-y-3">
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          <p className="text-sm text-text-primary font-medium">
            {q.header ? `${q.header}: ` : ""}{q.question}
          </p>
          {q.multiSelect && (
            <p className="text-xs text-text-subtle">Select multiple</p>
          )}
          <div className="flex flex-col gap-1">
            {q.options.map((opt, oi) => {
              const isOther = otherActive[q.question];
              const selected = !isOther && (answers[q.question] ?? "").split(", ").includes(opt.label);
              return (
                <button
                  key={oi}
                  onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                  className={`text-left rounded px-2.5 py-1.5 text-xs border transition-colors ${
                    selected
                      ? "border-accent bg-accent/20 text-text-primary"
                      : "border-border bg-background text-text-secondary hover:bg-surface-elevated"
                  }`}
                >
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && (
                    <span className="text-text-subtle ml-1.5">— {opt.description}</span>
                  )}
                </button>
              );
            })}
            {/* Other option */}
            {otherActive[q.question] ? (
              <input
                type="text"
                autoFocus
                placeholder="Type your answer..."
                value={answers[q.question] ?? ""}
                onChange={(e) => handleOtherText(q.question, e.target.value)}
                className="rounded px-2.5 py-1.5 text-xs border border-accent bg-accent/10 text-text-primary outline-none placeholder:text-text-subtle"
              />
            ) : (
              <button
                onClick={() => handleOtherToggle(q.question)}
                className="text-left rounded px-2.5 py-1.5 text-xs border border-dashed border-border text-text-subtle hover:bg-surface-elevated transition-colors"
              >
                Other — type your own answer
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onRespond(approval.requestId, true, answers)}
          disabled={!allAnswered}
          className="px-4 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Submit
        </button>
        <button
          onClick={() => onRespond(approval.requestId, false)}
          className="px-4 py-1.5 rounded bg-surface-elevated text-text-secondary text-xs hover:bg-surface transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
