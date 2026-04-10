import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { getAuthToken } from "@/lib/api-client";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import type { SessionPhase } from "../../../types/api";
import { ToolCard } from "./tool-cards";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { cn, basename } from "@/lib/utils";

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
} from "lucide-react";
import { ChatWelcome } from "./chat-welcome";
import { QuestionCard } from "./question-card";
import type { Question } from "./question-card";
import { useTabStore } from "@/stores/tab-store";
import { api } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import { useImageOverlay } from "@/stores/image-overlay-store";

interface MessageListProps {
  messages: ChatMessage[];
  messagesLoading?: boolean;
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
  /** Called when user selects a recent session from the welcome screen */
  onSelectSession?: (session: import("../../../types/chat").SessionInfo) => void;
}

export function MessageList({
  messages,
  messagesLoading,
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
      <ChatWelcome
        projectName={projectName || ""}
        onSelectSession={onSelectSession || (() => {})}
      />
    );
  }

  const filtered = useMemo(() => messages.filter((msg) => {
    const hasContent = msg.content && msg.content.trim().length > 0;
    const hasEvents = msg.events && msg.events.length > 0;
    // User bubbles only render text — hide SDK tool-result user messages
    // that have no text content (their events are merged into assistant)
    if (msg.role === "user") return hasContent;
    return hasContent || hasEvents;
  }), [messages]);

  return (
    <div className="relative flex-1 overflow-hidden flex flex-col min-h-0">
      <StickToBottom className="flex-1 overflow-y-auto overflow-x-hidden" resize="smooth" initial="instant">
        <StickToBottom.Content className="p-4 space-y-4">
          {filtered.map((msg, idx) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={isStreaming && msg.id.startsWith("streaming-")}
                projectName={projectName}
                onFork={msg.role === "user" && onFork ? () => {
                  // Pass the SDK UUID of the previous assistant message for fork (JSONL-level message ID)
                  const prevMsg = idx > 0 ? filtered[idx - 1] : undefined;
                  onFork(msg.content, prevMsg?.sdkUuid ?? prevMsg?.id);
                } : undefined}
              />
            ))}

        {pendingApproval && (
          pendingApproval.tool === "AskUserQuestion"
            ? <AskUserQuestionCard approval={pendingApproval} onRespond={onApprovalResponse} />
            : <ApprovalCard approval={pendingApproval} onRespond={onApprovalResponse} />
        )}

        {isStreaming && <ThinkingIndicator lastMessage={messages[messages.length - 1]} phase={phase} elapsed={connectingElapsed} statusMessage={statusMessage} />}
        {!isStreaming && compactStatus === "compacting" && <ThinkingIndicator lastMessage={undefined} phase="thinking" elapsed={undefined} statusMessage="Compacting messages..." />}
      </StickToBottom.Content>
      <ScrollToBottomButton />
    </StickToBottom>
    </div>
  );
}

/** Floating button to scroll back to bottom when user has scrolled up */
function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      onClick={() => scrollToBottom()}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-3 py-1 rounded-full bg-surface-elevated border border-border text-xs text-text-secondary hover:text-foreground shadow-lg transition-all"
    >
      <ChevronDown className="size-3" />
      Scroll to bottom
    </button>
  );
}

function MessageBubble({ message, isStreaming, projectName, onFork }: { message: ChatMessage; isStreaming: boolean; projectName?: string; onFork?: () => void }) {
  if (message.role === "user") {
    return (
      <UserBubble content={message.content} projectName={projectName} onFork={onFork} />
    );
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
      {message.accountLabel && (
        <p className="text-[10px] select-none" style={{ color: "var(--color-text-subtle)" }}>
          via {message.accountLabel}
        </p>
      )}
    </div>
  );
}

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
};

/** Extract system-injected XML tags into structured objects + clean text */
function extractSystemTags(text: string): { cleanText: string; tags: SystemTag[] } {
  const tags: SystemTag[] = [];
  const tagPattern = /<(system-reminder|available-deferred-tools|antml:[\w-]+|fast_mode_info|claudeMd|gitStatus|currentDate|task-notification|environment_details)[^>]*>([\s\S]*?)<\/\1>/g;
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
const SYSTEM_TAG_NAMES = new Set(["task-notification", "environment_details"]);

/** User message bubble — full width, collapsible, with system tag badges */
function UserBubble({ content, projectName, onFork }: { content: string; projectName?: string; onFork?: () => void }) {
  const { files, text, tags } = useMemo(() => {
    const parsed = parseUserAttachments(content);
    const { cleanText, tags } = extractSystemTags(parsed.text);
    return { files: parsed.files, text: cleanText, tags };
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
    <div className={cn(
      "group/user relative rounded-lg px-3 py-2 text-sm border shadow-sm",
      isSystemContext
        ? "bg-surface/40 border-border/40 text-text-secondary"
        : "bg-primary/10 border-primary/15 text-text-primary",
    )}>
      {/* System tags as badges */}
      {tags.length > 0 && <SystemTagBadges tags={tags} />}

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

      {/* Text content — 2-line clamp by default, expandable */}
      {text && (
        <div
          ref={contentRef}
          className={cn(
            "whitespace-pre-wrap break-words transition-all duration-200",
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
      {/* Fork/Rewind button — only for real user messages */}
      {!isSystemContext && onFork && (
        <button
          onClick={onFork}
          title="Retry from this message (fork session)"
          className="absolute top-1.5 right-1.5 can-hover:opacity-0 can-hover:group-hover/user:opacity-100 transition-opacity size-5 flex items-center justify-center rounded text-text-subtle hover:text-text-primary"
        >
          <RotateCcw className="size-3" />
        </button>
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
        {isOk ? <CheckCircle2 className="size-2.5 text-green-500" /> : <XCircle className="size-2.5 text-yellow-500" />}
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

/** Hook: fetch an image via auth header, return blob URL */
function useAuthBlob(src: string): { blobUrl: string | null; error: boolean } {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url: string | undefined;
    const token = getAuthToken();
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error("Failed"); return r.blob(); })
      .then((blob) => {
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch(() => { if (!revoked) setError(true); });
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [src]);

  return { blobUrl, error };
}

/** Fetches image with auth header, renders as blob URL — click opens lightbox */
function AuthImage({ src, alt }: { src: string; alt: string }) {
  const { blobUrl, error } = useAuthBlob(src);
  const openOverlay = useImageOverlay((s) => s.open);

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
    <button type="button" onClick={() => openOverlay(blobUrl, alt)} className="block text-left">
      <img
        src={blobUrl}
        alt={alt}
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
        <p className="text-xs text-yellow-500/80 ml-5">
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
  return <MarkdownRenderer content={cleaned} projectName={projectName} codeActions isStreaming={isStreaming} />;
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
