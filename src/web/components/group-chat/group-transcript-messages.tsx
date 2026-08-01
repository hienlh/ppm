import { useState } from "react";
import { ChevronRight, Brain, Settings2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { ToolCard } from "@/components/chat/tool-cards";
import { cn } from "@/lib/utils";
import type { ChatMessage, ChatEvent } from "../../../types/chat";
import type { TranscriptConfig } from "@/lib/api-group-chat";

interface Props {
  messages: ChatMessage[];
  config: TranscriptConfig | null;
  projectName?: string;
}

/** Read-only, chat-style render of an archived member transcript: text (markdown),
 *  collapsible thinking, tool calls with inputs + outputs, and the session input config.
 *  Deliberately minimal — no approvals / fork / version affordances. */
export function GroupTranscriptMessages({ messages, config, projectName }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {config && <ConfigBlock config={config} />}
      {messages.map((m) => (
        <div key={m.id} className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
            {m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role}
          </span>
          <MessageBody message={m} projectName={projectName} />
        </div>
      ))}
      {messages.length === 0 && (
        <p className="py-6 text-center text-sm text-text-subtle">Transcript is empty.</p>
      )}
    </div>
  );
}

function MessageBody({ message, projectName }: { message: ChatMessage; projectName?: string }) {
  const events = message.events ?? [];
  if (events.length === 0) {
    return message.content.trim()
      ? <MarkdownRenderer content={message.content} />
      : null;
  }
  // Match tool_result events to their tool_use by id (rendered inside the ToolCard).
  const resultById = new Map<string, ChatEvent>();
  for (const ev of events) {
    if (ev.type === "tool_result" && ev.toolUseId) resultById.set(ev.toolUseId, ev);
  }
  return (
    <div className="flex flex-col gap-2">
      {events.map((ev, i) => {
        if (ev.type === "text") {
          return ev.content.trim() ? <MarkdownRenderer key={i} content={ev.content} /> : null;
        }
        if (ev.type === "thinking") {
          return <ThinkingBlock key={i} content={ev.content} />;
        }
        if (ev.type === "tool_use") {
          const result = ev.toolUseId ? resultById.get(ev.toolUseId) : undefined;
          return <ToolCard key={i} tool={ev} result={result} completed={!!result} projectName={projectName} />;
        }
        return null; // tool_result rendered via its tool_use
      })}
    </div>
  );
}

/** Collapsible reasoning block (collapsed by default). */
function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-surface-elevated/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-subtle hover:text-text-secondary"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Brain className="size-3.5" />
        <span>Thinking</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 text-xs leading-relaxed text-text-secondary">
          <MarkdownRenderer content={content} />
        </div>
      )}
    </div>
  );
}

/** Collapsible input-config summary (model / cwd / branch / version / permission mode). */
function ConfigBlock({ config }: { config: TranscriptConfig }) {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string | undefined]> = [
    ["Model", config.model],
    ["Permission", config.permissionMode],
    ["CWD", config.cwd],
    ["Git branch", config.gitBranch],
    ["CLI version", config.version],
  ];
  const shown = rows.filter(([, v]) => v);
  if (shown.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-surface-elevated/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Settings2 className="size-3.5" />
        <span>Input config</span>
      </button>
      {open && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs">
          {shown.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-subtle">{k}</dt>
              <dd className="break-all font-mono text-text-secondary">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
