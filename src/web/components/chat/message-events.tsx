/**
 * The assistant's half: text, thinking and tool cards, in the order they arrived.
 *
 * Consecutive text events are merged into one bubble and the tool cards render
 * between those sections, so a turn reads as one answer with its work shown
 * inline rather than as a list of events.
 */
import { useState, useEffect, useRef } from "react";
import { ChevronRight, Loader2 } from "@/lib/icons";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import type { SessionPhase } from "../../../types/api";
import type { BashPartialEntry } from "../../hooks/use-chat";
import { ToolCard } from "./tool-cards";
import { MarkdownContent } from "./message-markdown";

/**
 * Renders events in order — consecutive text events merged into one bubble,
 * tool_use/tool_result render as cards between text sections.
 * Last text group shows streaming cursor when actively streaming.
 */
type EventGroup =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; tool: ChatEvent; result?: ChatEvent; completed?: boolean };

export function InterleavedEvents({ events, isStreaming, projectName, bashPartialOutput }: {
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
      // A call may be announced before it has anything to show and re-announced
      // once it does — image generation starts with no file and no prompt, and
      // only learns both when it finishes. The later event describes the same
      // call, so it replaces the card rather than adding a second one.
      const useId = (event as any).toolUseId;
      const existing = useId
        ? groups.find(
            (g) => g.kind === "tool" && g.tool.type === "tool_use" && (g.tool as any).toolUseId === useId,
          ) as (EventGroup & { kind: "tool" }) | undefined
        : undefined;
      if (existing) {
        existing.tool = event;
        continue;
      }
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
        g.result = { type: "tool_result", output: embedded.output, isError: embedded.isError, exitCode: embedded.exitCode } as ChatEvent;
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
          return <ThinkingBlock key={`think-${i}`} content={group.content} projectName={projectName} isStreaming={isStreaming && i === groups.length - 1} />;
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

/** Collapsible thinking block — shows the provider's safe reasoning summary, collapsed by default when done */
function ThinkingBlock({ content, projectName, isStreaming }: { content: string; projectName?: string; isStreaming: boolean }) {
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
          <div className="px-2 pb-2 text-text-subtle/80 text-[11px] leading-relaxed">
            <MarkdownContent content={content} projectName={projectName} isStreaming={isStreaming} />
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
export function ThinkingIndicator({ lastMessage, phase, elapsed, statusMessage }: { lastMessage?: ChatMessage; phase?: SessionPhase; elapsed?: number; statusMessage?: string | null }) {
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
