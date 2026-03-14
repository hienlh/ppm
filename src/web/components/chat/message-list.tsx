import { useEffect, useRef, useState } from "react";
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
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {pendingApproval && (
        <ApprovalCard
          approval={pendingApproval}
          onRespond={onApprovalResponse}
        />
      )}

      {isStreaming && (
        <div className="flex items-center gap-2 text-text-subtle text-sm pl-10">
          <span className="animate-pulse">Thinking...</span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
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

  // Assistant message
  return (
    <div className="flex items-start gap-2">
      <div className="flex items-center justify-center size-7 rounded-full bg-accent/20 text-accent shrink-0 mt-0.5">
        <Bot className="size-4" />
      </div>
      <div className="flex flex-col gap-2 max-w-[85%] min-w-0">
        {message.content && (
          <div className="rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary">
            <AssistantContent content={message.content} />
          </div>
        )}
        {message.events?.map((event, i) => (
          <EventCard key={i} event={event} />
        ))}
      </div>
    </div>
  );
}

/** Renders assistant text with basic code block support */
function AssistantContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0]?.trim() ?? "";
          const code = lang ? lines.slice(1).join("\n") : lines.join("\n");
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded bg-bg-primary p-2 text-xs font-mono border border-border"
            >
              {lang && (
                <span className="text-text-subtle text-xs mb-1 block">
                  {lang}
                </span>
              )}
              <code>{code}</code>
            </pre>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            {part}
          </p>
        );
      })}
    </div>
  );
}

function EventCard({ event }: { event: ChatEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (event.type === "text") return null; // Text is rendered inline

  if (event.type === "tool_use") {
    return (
      <div className="rounded border border-border bg-bg-primary text-xs">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-bg-secondary transition-colors"
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
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
      <div className="rounded border border-border bg-bg-primary text-xs">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-bg-secondary transition-colors"
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
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

  // approval_request and done handled elsewhere
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
      <pre className="text-xs font-mono text-text-secondary overflow-x-auto bg-bg-primary rounded p-2 border border-border">
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
