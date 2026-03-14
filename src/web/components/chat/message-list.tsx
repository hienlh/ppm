import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { marked } from "marked";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import {
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Wrench,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";

interface MessageListProps {
  messages: ChatMessage[];
  pendingApproval: { requestId: string; tool: string; input: unknown } | null;
  onApprovalResponse: (requestId: string, approved: boolean) => void;
  isStreaming: boolean;
}

export function MessageList({
  messages,
  pendingApproval,
  onApprovalResponse,
  isStreaming,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingApproval]);

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
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          isStreaming={isStreaming && msg.id.startsWith("streaming-")}
        />
      ))}

      {pendingApproval && (
        <ApprovalCard
          approval={pendingApproval}
          onRespond={onApprovalResponse}
        />
      )}

      {isStreaming && <ThinkingIndicator lastMessage={messages[messages.length - 1]} />}

      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex items-start gap-2">
        <div className="flex items-center justify-center size-7 rounded-full bg-primary/20 text-primary shrink-0 mt-0.5">
          <User className="size-4" />
        </div>
        <div className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-text-primary max-w-[85%]">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="flex items-start gap-2 pl-9">
        <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400 w-full">
          <AlertCircle className="size-4 shrink-0" />
          <p>{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message — render events in order (text interleaved with tool calls)
  return (
    <div className="flex items-start gap-2">
      <div className="flex items-center justify-center size-7 rounded-full bg-accent/20 text-accent shrink-0 mt-0.5">
        <Bot className="size-4" />
      </div>
      <div className="flex flex-col gap-2 max-w-[85%] min-w-0">
        {message.events && message.events.length > 0
          ? <InterleavedEvents events={message.events} isStreaming={isStreaming} />
          : message.content && (
              <div className="rounded-lg bg-surface px-3 py-2 text-sm text-text-primary">
                <MarkdownContent content={message.content} />
              </div>
            )}
      </div>
    </div>
  );
}

/**
 * Renders events in order — consecutive text events merged into one bubble,
 * tool_use/tool_result render as cards between text sections.
 * Last text group shows streaming cursor when actively streaming.
 */
function InterleavedEvents({ events, isStreaming }: { events: ChatEvent[]; isStreaming: boolean }) {
  // Group consecutive text events into single text blocks.
  // Computed every render — events array is new each time from streaming.
  const groups: Array<{ kind: "text"; content: string } | { kind: "event"; event: ChatEvent }> = [];
  let textBuffer = "";

  for (const event of events) {
    if (event.type === "text") {
      textBuffer += event.content;
    } else {
      if (textBuffer) {
        groups.push({ kind: "text", content: textBuffer });
        textBuffer = "";
      }
      groups.push({ kind: "event", event });
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
            <div key={`text-${i}`} className="rounded-lg bg-surface px-3 py-2 text-sm text-text-primary">
              <StreamingText content={group.content} animate={isLast} />
            </div>
          );
        }
        return <EventCard key={`evt-${i}`} event={group.event} />;
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
      <div className="flex items-center gap-2 text-text-subtle text-sm pl-10">
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
        <div className="flex items-center gap-2 text-text-subtle text-sm pl-10">
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

function EventCard({ event }: { event: ChatEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (event.type === "text") return null;

  if (event.type === "tool_use") {
    return (
      <div className="rounded border border-border bg-background text-xs">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-surface transition-colors"
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Wrench className="size-3 text-yellow-400" />
          <span className="font-medium text-text-primary">{event.tool}</span>
        </button>
        {expanded && (
          <pre className="px-2 pb-2 overflow-x-auto text-text-secondary font-mono">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (event.type === "tool_result") {
    return (
      <div className="rounded border border-border bg-background text-xs">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-surface transition-colors"
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <CheckCircle2 className="size-3 text-green-400" />
          <span className="text-text-secondary">Tool result</span>
        </button>
        {expanded && (
          <pre className="px-2 pb-2 overflow-x-auto text-text-secondary font-mono max-h-40">
            {event.output}
          </pre>
        )}
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="flex items-center gap-2 rounded bg-red-500/10 border border-red-500/20 px-2 py-1.5 text-xs text-red-400">
        <AlertCircle className="size-3" />
        <span>{event.message}</span>
      </div>
    );
  }

  return null;
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: { requestId: string; tool: string; input: unknown };
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  return (
    <div className="ml-9 rounded-lg border-2 border-yellow-500/40 bg-yellow-500/10 p-3 space-y-2">
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
