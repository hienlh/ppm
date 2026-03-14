import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import type { ChatMessage } from "../../hooks/use-chat";

function CollapsibleCard({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded text-xs">
      <button
        className="flex items-center gap-1 px-2 py-1.5 w-full text-left text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {title}
      </button>
      {open && (
        <pre className="px-2 pb-2 overflow-auto max-h-40 text-foreground whitespace-pre-wrap break-all">
          {children}
        </pre>
      )}
    </div>
  );
}

function renderTextWithCode(text: string) {
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("```")) {
      const code = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
      return (
        <pre key={i} className="bg-muted rounded p-2 overflow-auto text-xs my-1 whitespace-pre-wrap">
          {code}
        </pre>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="bg-muted px-1 rounded text-xs">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const { event } = msg;

  if (event.type === "user_text") {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-3 py-2 max-w-[80%] text-sm whitespace-pre-wrap break-words">
          {event.content}
        </div>
      </div>
    );
  }

  if (event.type === "text") {
    return (
      <div className="flex justify-start px-3 py-1">
        <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 max-w-[85%] text-sm break-words">
          {renderTextWithCode(event.content)}
        </div>
      </div>
    );
  }

  if (event.type === "tool_use") {
    return (
      <div className="px-3 py-1">
        <CollapsibleCard title={`Tool: ${event.tool}`}>
          {JSON.stringify(event.input, null, 2)}
        </CollapsibleCard>
      </div>
    );
  }

  if (event.type === "tool_result") {
    return (
      <div className="px-3 py-1">
        <CollapsibleCard title="Tool Result">{event.output}</CollapsibleCard>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="px-3 py-1">
        <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5">
          {event.message}
        </div>
      </div>
    );
  }

  if (event.type === "approval_request") {
    return null; // handled by ToolApproval component
  }

  return null;
}

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <ScrollArea className="flex-1">
      <div className="py-2 flex flex-col gap-0.5">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
