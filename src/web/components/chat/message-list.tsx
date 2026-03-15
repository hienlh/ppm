import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { marked } from "marked";
import { getAuthToken } from "@/lib/api-client";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Wrench,
  CheckCircle2,
  ShieldAlert,
  Bot,
  FileText,
  Image as ImageIcon,
} from "lucide-react";

interface MessageListProps {
  messages: ChatMessage[];
  messagesLoading?: boolean;
  pendingApproval: { requestId: string; tool: string; input: unknown } | null;
  onApprovalResponse: (requestId: string, approved: boolean, data?: unknown) => void;
  isStreaming: boolean;
  projectName?: string;
}

export function MessageList({
  messages,
  messagesLoading,
  pendingApproval,
  onApprovalResponse,
  isStreaming,
  projectName,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const initialLoadRef = useRef(true);

  useEffect(() => {
    // First load: jump instantly. Subsequent updates: smooth scroll.
    const behavior = initialLoadRef.current ? "instant" : "smooth";
    bottomRef.current?.scrollIntoView({ behavior: behavior as ScrollBehavior });
    if (initialLoadRef.current && messages.length > 0) {
      initialLoadRef.current = false;
    }
  }, [messages, pendingApproval]);

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
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages
        .filter((msg) => {
          // Skip empty messages: no text content AND no events
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
          />
        ))}

      {pendingApproval && (
        pendingApproval.tool === "AskUserQuestion"
          ? <AskUserQuestionCard approval={pendingApproval} onRespond={onApprovalResponse} />
          : <ApprovalCard approval={pendingApproval} onRespond={onApprovalResponse} />
      )}

      {isStreaming && <ThinkingIndicator lastMessage={messages[messages.length - 1]} />}

      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message, isStreaming, projectName }: { message: ChatMessage; isStreaming: boolean; projectName?: string }) {
  if (message.role === "user") {
    return <UserBubble content={message.content} projectName={projectName} />;
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
        ? <InterleavedEvents events={message.events} isStreaming={isStreaming} />
        : message.content && (
            <div className="text-sm text-text-primary">
              <MarkdownContent content={message.content} />
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
  const filename = filePath.split("/").pop() ?? "";
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
function UserBubble({ content, projectName }: { content: string; projectName?: string }) {
  const { files, text } = useMemo(() => parseUserAttachments(content), [content]);

  return (
    <div className="flex justify-end">
      <div className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-text-primary max-w-[85%] space-y-2">
        {/* Attached files */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((filePath, i) =>
              isImagePath(filePath) ? (
                <AuthImage
                  key={i}
                  src={uploadPreviewUrl(filePath, projectName)}
                  alt={filePath.split("/").pop() ?? "image"}
                />
              ) : isPdfPath(filePath) ? (
                <AuthFileLink
                  key={i}
                  src={uploadPreviewUrl(filePath, projectName)}
                  filename={filePath.split("/").pop() ?? "document.pdf"}
                  mimeType="application/pdf"
                />
              ) : (
                <div
                  key={i}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary"
                >
                  <FileText className="size-3.5 shrink-0" />
                  <span className="truncate max-w-40">{filePath.split("/").pop()}</span>
                </div>
              ),
            )}
          </div>
        )}

        {/* Text content */}
        {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
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
  | { kind: "tool"; tool: ChatEvent; result?: ChatEvent };

function InterleavedEvents({ events, isStreaming }: { events: ChatEvent[]; isStreaming: boolean }) {
  // Group: consecutive text → merged text block; tool_use + following tool_result → single tool block
  const groups: EventGroup[] = [];
  let textBuffer = "";

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "text") {
      textBuffer += event.content;
    } else if (event.type === "tool_use") {
      if (textBuffer) {
        groups.push({ kind: "text", content: textBuffer });
        textBuffer = "";
      }
      // Check if next event is its tool_result
      const next = events[i + 1];
      if (next?.type === "tool_result") {
        groups.push({ kind: "tool", tool: event, result: next });
        i++; // skip the result
      } else {
        groups.push({ kind: "tool", tool: event });
      }
    } else if (event.type === "tool_result") {
      // Orphan tool_result (not preceded by tool_use) — attach to last tool group
      if (textBuffer) {
        groups.push({ kind: "text", content: textBuffer });
        textBuffer = "";
      }
      const lastTool = [...groups].reverse().find((g) => g.kind === "tool") as EventGroup & { kind: "tool" } | undefined;
      if (lastTool && !lastTool.result) {
        lastTool.result = event;
      }
      // else: skip orphan tool_results — already merged by backend
    } else {
      if (textBuffer) {
        groups.push({ kind: "text", content: textBuffer });
        textBuffer = "";
      }
      groups.push({ kind: "tool", tool: event });
    }
  }
  if (textBuffer) {
    groups.push({ kind: "text", content: textBuffer });
  }

  return (
    <>
      {groups.map((group, i) => {
        if (group.kind === "text") {
          const isLast = isStreaming && i === groups.length - 1;
          return (
            <div key={`text-${i}`} className="text-sm text-text-primary">
              <StreamingText content={group.content} animate={isLast} />
            </div>
          );
        }
        return <ToolCard key={`tool-${i}`} tool={group.tool} result={group.result} />;
      })}
    </>
  );
}

/**
 * Text component with typewriter effect.
 * When `animate=true`, reveals content progressively.
 * When `animate=false` (finalized), shows full content instantly.
 */
function StreamingText({ content, animate }: { content: string; animate: boolean }) {
  const [displayed, setDisplayed] = useState(content);
  const prevLenRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!animate) {
      // Not streaming — show everything immediately
      setDisplayed(content);
      prevLenRef.current = content.length;
      return;
    }

    // If content grew, animate from where we left off
    const prevLen = prevLenRef.current;
    if (content.length <= prevLen) {
      setDisplayed(content);
      return;
    }

    let cursor = prevLen;
    const target = content.length;
    // Reveal ~20 chars per frame (~60fps = ~1200 chars/sec)
    const charsPerFrame = Math.max(3, Math.ceil((target - cursor) / 30));

    const step = () => {
      cursor = Math.min(cursor + charsPerFrame, target);
      setDisplayed(content.slice(0, cursor));
      if (cursor < target) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        prevLenRef.current = target;
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [content, animate]);

  // When streaming finishes, sync to full content
  useEffect(() => {
    if (!animate) {
      setDisplayed(content);
      prevLenRef.current = content.length;
    }
  }, [animate, content]);

  return (
    <>
      <MarkdownContent content={displayed} />
      {animate && <StreamingCursor />}
    </>
  );
}

/** Blinking cursor shown at the end of streaming text */
function StreamingCursor() {
  return (
    <span className="inline-block w-[2px] h-[1em] bg-accent ml-0.5 align-text-bottom animate-blink" />
  );
}

/**
 * Shows "Thinking..." when:
 * - No assistant message yet (waiting for first response)
 * - Last event is tool_use/tool_result (waiting for Claude after tool execution)
 */
function ThinkingIndicator({ lastMessage }: { lastMessage?: ChatMessage }) {
  // No assistant message yet
  if (!lastMessage || lastMessage.role !== "assistant") {
    return (
      <div className="flex items-center gap-2 text-text-subtle text-sm">
        <span className="animate-pulse">Thinking...</span>
      </div>
    );
  }

  // Check if last event is non-text (tool_use, tool_result) → waiting for next response
  const events = lastMessage.events;
  if (events && events.length > 0) {
    const lastEvent = events[events.length - 1]!;
    if (lastEvent?.type === "tool_use" || lastEvent?.type === "tool_result") {
      return (
        <div className="flex items-center gap-2 text-text-subtle text-sm">
          <span className="animate-pulse">Thinking...</span>
        </div>
      );
    }
  }

  return null;
}

/** Configure marked for safe rendering */
marked.setOptions({
  gfm: true,
  breaks: true,
});

/** Renders markdown content using `marked` → HTML string */
function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => {
    try {
      return marked.parse(content) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className="markdown-content prose-sm"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Unified tool card: shows tool-specific summary + expandable details */
function ToolCard({ tool, result }: { tool: ChatEvent; result?: ChatEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (tool.type === "error") {
    return (
      <div className="flex items-center gap-2 rounded bg-red-500/10 border border-red-500/20 px-2 py-1.5 text-xs text-red-400">
        <AlertCircle className="size-3" />
        <span>{tool.message}</span>
      </div>
    );
  }

  const isApproval = tool.type === "approval_request";
  const toolName = tool.type === "tool_use"
    ? tool.tool
    : isApproval
      ? (tool as any).tool ?? "Tool"
      : "Tool";
  const input = tool.type === "tool_use"
    ? (tool.input as Record<string, unknown>)
    : isApproval
      ? ((tool as any).input as Record<string, unknown>) ?? {}
      : {};
  const hasResult = result?.type === "tool_result";
  // AskUserQuestion with answers already submitted → show as completed
  const hasAnswers = toolName === "AskUserQuestion" && !!(input as any)?.answers;

  return (
    <div className="rounded border border-border bg-background text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-surface transition-colors min-w-0"
      >
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {(hasResult || hasAnswers)
          ? <CheckCircle2 className="size-3 text-green-400 shrink-0" />
          : <Wrench className="size-3 text-yellow-400 shrink-0" />
        }
        <span className="truncate text-text-primary">
          <ToolSummary name={toolName} input={input} />
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5">
          {(tool.type === "tool_use" || isApproval) && (
            <ToolDetails name={toolName} input={input} />
          )}
          {hasResult && (
            <pre className="overflow-x-auto text-text-subtle font-mono max-h-40 border-t border-border pt-1.5 whitespace-pre-wrap break-all">
              {(result as any).output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Render one-line summary per tool type */
function ToolSummary({ name, input }: { name: string; input: Record<string, unknown> }) {
  const s = (v: unknown) => String(v ?? "");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return <>{name} <span className="text-text-subtle">{basename(s(input.file_path))}</span></>;
    case "Bash":
      return <>{name} <span className="font-mono text-text-subtle">{truncate(s(input.command), 60)}</span></>;
    case "Glob":
      return <>{name} <span className="font-mono text-text-subtle">{s(input.pattern)}</span></>;
    case "Grep":
      return <>{name} <span className="font-mono text-text-subtle">{truncate(s(input.pattern), 40)}</span></>;
    case "WebSearch":
      return <>{name} <span className="text-text-subtle">{truncate(s(input.query), 50)}</span></>;
    case "WebFetch":
      return <>{name} <span className="text-text-subtle">{truncate(s(input.url), 50)}</span></>;
    case "AskUserQuestion": {
      const qs = (input.questions as Array<{ question: string }>) ?? [];
      const hasAns = !!(input.answers);
      return <>{name} <span className="text-text-subtle">{qs.length} question{qs.length !== 1 ? "s" : ""}{hasAns ? " ✓" : ""}</span></>;
    }
    default:
      return <>{name}</>;
  }
}

/** Render expanded details per tool type */
function ToolDetails({ name, input }: { name: string; input: Record<string, unknown> }) {
  const s = (v: unknown) => String(v ?? "");
  switch (name) {
    case "Bash":
      return (
        <div className="space-y-1">
          {!!input.description && <p className="text-text-subtle italic">{s(input.description)}</p>}
          <pre className="font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">{s(input.command)}</pre>
        </div>
      );
    case "Read":
    case "Write":
    case "Edit":
      return (
        <div className="space-y-1">
          <p className="font-mono text-text-secondary break-all">{s(input.file_path)}</p>
          {name === "Edit" && !!input.old_string && (
            <div className="border-l-2 border-red-400/40 pl-2">
              <pre className="font-mono text-red-400/70 overflow-x-auto whitespace-pre-wrap">{truncate(s(input.old_string), 200)}</pre>
            </div>
          )}
          {name === "Edit" && !!input.new_string && (
            <div className="border-l-2 border-green-400/40 pl-2">
              <pre className="font-mono text-green-400/70 overflow-x-auto whitespace-pre-wrap">{truncate(s(input.new_string), 200)}</pre>
            </div>
          )}
          {name === "Write" && !!input.content && (
            <pre className="font-mono text-text-subtle overflow-x-auto max-h-32 whitespace-pre-wrap">{truncate(s(input.content), 300)}</pre>
          )}
        </div>
      );
    case "Glob":
      return <p className="font-mono text-text-secondary">{s(input.pattern)}{input.path ? ` in ${s(input.path)}` : ""}</p>;
    case "Grep":
      return (
        <div className="space-y-0.5">
          <p className="font-mono text-text-secondary">/{s(input.pattern)}/</p>
          {!!input.path && <p className="text-text-subtle">in {s(input.path)}</p>}
        </div>
      );
    case "AskUserQuestion": {
      const qs = (input.questions as Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>) ?? [];
      const answers = (input.answers as Record<string, string>) ?? {};
      return (
        <div className="space-y-2">
          {qs.map((q, i) => (
            <div key={i} className="space-y-0.5">
              <p className="text-text-primary font-medium">{q.header ? `${q.header}: ` : ""}{q.question}</p>
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt, oi) => {
                  const answer = answers[q.question] ?? "";
                  const isSelected = answer.split(", ").includes(opt.label);
                  return (
                    <span key={oi} className={`inline-block rounded px-1.5 py-0.5 text-xs border ${
                      isSelected ? "border-accent bg-accent/20 text-text-primary" : "border-border text-text-subtle"
                    }`}>
                      {opt.label}
                    </span>
                  );
                })}
              </div>
              {answers[q.question] && (
                <p className="text-accent text-xs">Answer: {answers[q.question]}</p>
              )}
            </div>
          ))}
        </div>
      );
    }
    default:
      return (
        <pre className="overflow-x-auto text-text-secondary font-mono whitespace-pre-wrap break-all">
          {JSON.stringify(input, null, 2)}
        </pre>
      );
  }
}

function basename(path?: string): string {
  if (!path) return "";
  return path.split("/").pop() ?? path;
}

function truncate(str?: string, max = 50): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

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
