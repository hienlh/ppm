/**
 * Tool card components for chat message rendering.
 * Handles summary + details for all SDK tool types.
 */
import { useState, useMemo } from "react";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  ListTodo,
  Search,
  Bot,
  Globe,
  Code,
  Columns2,
} from "lucide-react";
import type { ChatEvent } from "../../../types/chat";
import { useTabStore } from "@/stores/tab-store";
import { basename } from "@/lib/utils";

/** Extract tool name and input from a ChatEvent */
function extractToolInfo(tool: ChatEvent): { toolName: string; input: Record<string, unknown> } {
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
  return { toolName, input };
}

/** Unified tool card: shows tool-specific summary + expandable details */
export function ToolCard({
  tool,
  result,
  completed,
  projectName,
}: {
  tool: ChatEvent;
  result?: ChatEvent;
  completed?: boolean;
  projectName?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (tool.type === "error") {
    return (
      <div className="flex items-center gap-2 rounded bg-red-500/10 border border-red-500/20 px-2 py-1.5 text-xs text-red-400">
        <AlertCircle className="size-3" />
        <span>{tool.message}</span>
      </div>
    );
  }

  const { toolName, input } = extractToolInfo(tool);
  const hasResult = result?.type === "tool_result";
  const isError = hasResult && !!(result as any).isError;
  const hasAnswers = toolName === "AskUserQuestion" && !!(input as any)?.answers;
  const isSubagent = (toolName === "Agent" || toolName === "Task") && tool.type === "tool_use";
  const children = isSubagent ? (tool as any).children as ChatEvent[] | undefined : undefined;
  const hasChildren = children && children.length > 0;
  const isDone = hasResult || hasAnswers || completed;

  return (
    <div className={`rounded border text-xs ${isSubagent ? "border-accent/30 bg-accent/5" : "border-border bg-background"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-2 py-1.5 w-full text-left hover:bg-surface transition-colors min-w-0"
      >
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {isError
          ? <XCircle className="size-3 text-red-400 shrink-0" />
          : isDone
            ? <CheckCircle2 className="size-3 text-green-400 shrink-0" />
            : <Loader2 className="size-3 text-yellow-400 shrink-0 animate-spin" />}
        <span className="truncate text-text-primary">
          <ToolSummary name={toolName} input={input} />
        </span>
        {hasChildren && (
          <span className="ml-auto text-[10px] text-text-subtle shrink-0">{children!.length} steps</span>
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5">
          {(tool.type === "tool_use" || tool.type === "approval_request") && (
            <ToolDetails name={toolName} input={input} projectName={projectName} />
          )}
          {/* Subagent children: render nested tool events */}
          {hasChildren && (
            <SubagentChildren events={children!} projectName={projectName} />
          )}
          {hasResult && (
            <ToolResultView toolName={toolName} output={(result as any).output} />
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
    case "MultiEdit":
    case "NotebookEdit":
      return <>{name} <span className="text-text-subtle">{basename(s(input.file_path))}</span></>;
    case "Bash":
      return <>{name} <span className="font-mono text-text-subtle">{truncate(s(input.command), 60)}</span></>;
    case "Glob":
      return <>{name} <span className="font-mono text-text-subtle">{s(input.pattern)}</span></>;
    case "Grep":
      return <>{name} <span className="font-mono text-text-subtle">{truncate(s(input.pattern), 40)}</span></>;
    case "WebSearch":
      return <><Search className="size-3 inline" /> {name} <span className="text-text-subtle">{truncate(s(input.query), 50)}</span></>;
    case "WebFetch":
      return <><Globe className="size-3 inline" /> {name} <span className="text-text-subtle">{truncate(s(input.url), 50)}</span></>;
    case "ToolSearch":
      return <><Search className="size-3 inline" /> {name} <span className="text-text-subtle">{truncate(s(input.query), 50)}</span></>;
    case "Agent":
    case "Task":
      return <><Bot className="size-3 inline" /> {name} <span className="text-text-subtle">{truncate(s(input.description || input.prompt), 60)}</span></>;
    case "TodoWrite": {
      const todos = (input.todos as Array<{ content: string; status: string }>) ?? [];
      const done = todos.filter((t) => t.status === "completed").length;
      return <><ListTodo className="size-3 inline" /> {name} <span className="text-text-subtle">{done}/{todos.length} done</span></>;
    }
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
function ToolDetails({
  name,
  input,
  projectName,
}: {
  name: string;
  input: Record<string, unknown>;
  projectName?: string;
}) {
  const s = (v: unknown) => String(v ?? "");
  const { openTab } = useTabStore();

  /** Open a file in a new editor tab */
  const openFile = (filePath: string) => {
    if (!projectName) return;
    openTab({
      type: "editor",
      title: basename(filePath),
      metadata: { filePath, projectName },
      projectId: projectName,
      closable: true,
    });
  };

  /** Open inline diff tab for Edit tool changes */
  const openEditDiff = (filePath: string, oldStr: string, newStr: string) => {
    openTab({
      type: "git-diff",
      title: `Diff ${basename(filePath)}`,
      metadata: { filePath, projectName, original: oldStr, modified: newStr },
      projectId: projectName ?? null,
      closable: true,
    });
  };

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
    case "MultiEdit":
    case "NotebookEdit": {
      const filePath = s(input.file_path);
      return (
        <div className="space-y-1">
          <button
            type="button"
            className="font-mono text-text-secondary break-all hover:text-primary hover:underline text-left flex items-center gap-1"
            onClick={() => openFile(filePath)}
            title="Open file in editor"
          >
            <ExternalLink className="size-3 shrink-0" />
            {filePath}
          </button>
          {name === "Edit" && (!!input.old_string || !!input.new_string) && (
            <button
              type="button"
              className="text-text-subtle hover:text-primary hover:underline text-left flex items-center gap-1"
              onClick={() => openEditDiff(filePath, s(input.old_string), s(input.new_string))}
              title="View diff in new tab"
            >
              <Columns2 className="size-3 shrink-0" />
              View Diff
            </button>
          )}
          {name === "Write" && !!input.content && (
            <pre className="font-mono text-text-subtle overflow-x-auto max-h-32 whitespace-pre-wrap">{truncate(s(input.content), 300)}</pre>
          )}
        </div>
      );
    }
    case "Glob":
      return <p className="font-mono text-text-secondary">{s(input.pattern)}{input.path ? ` in ${s(input.path)}` : ""}</p>;
    case "Grep":
      return (
        <div className="space-y-0.5">
          <p className="font-mono text-text-secondary">/{s(input.pattern)}/</p>
          {!!input.path && <p className="text-text-subtle">in {s(input.path)}</p>}
        </div>
      );
    case "TodoWrite":
      return <TodoDetails todos={(input.todos as Array<{ content: string; status: string }>) ?? []} />;
    case "Agent":
    case "Task":
      return (
        <div className="space-y-1">
          {!!input.description && <p className="text-text-secondary font-medium">{s(input.description)}</p>}
          {!!input.subagent_type && <p className="text-text-subtle">Type: {s(input.subagent_type)}</p>}
          {!!input.prompt && <MiniMarkdown content={s(input.prompt)} maxHeight="max-h-48" />}
        </div>
      );
    case "ToolSearch":
      return (
        <div className="space-y-0.5">
          <p className="font-mono text-text-secondary">{s(input.query)}</p>
          {!!input.max_results && <p className="text-text-subtle">Max results: {s(input.max_results)}</p>}
        </div>
      );
    case "WebFetch":
      return (
        <div className="space-y-0.5">
          <a href={s(input.url)} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline break-all flex items-center gap-1">
            <Globe className="size-3 shrink-0" />
            {s(input.url)}
          </a>
          {!!input.prompt && <p className="text-text-subtle">{truncate(s(input.prompt), 100)}</p>}
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

/** Todo list display with checkboxes */
function TodoDetails({ todos }: { todos: Array<{ content: string; status: string }> }) {
  return (
    <div className="space-y-0.5">
      {todos.map((todo, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className={`shrink-0 mt-0.5 ${
            todo.status === "completed"
              ? "text-green-400"
              : todo.status === "in_progress"
                ? "text-yellow-400"
                : "text-text-subtle"
          }`}>
            {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○"}
          </span>
          <span className={todo.status === "completed" ? "line-through text-text-subtle" : "text-text-secondary"}>
            {todo.content}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Render tool result with smart formatting — markdown for Agent, collapsible JSON for others */
function ToolResultView({ toolName, output }: { toolName: string; output: string }) {
  const [showRaw, setShowRaw] = useState(false);

  // For Agent/Task results: try to extract text content from JSON array result
  const agentContent = useMemo(() => {
    if (toolName !== "Agent" && toolName !== "Task") return null;
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        // SDK returns [{type:"text", text:"..."}, ...] — extract text blocks
        const texts = parsed
          .filter((item: any) => item.type === "text" && item.text)
          .map((item: any) => item.text)
          .join("\n\n");
        if (texts) return texts;
      }
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not JSON — might be plain text
      if (output && !output.startsWith("[{")) return output;
    }
    return null;
  }, [toolName, output]);

  // Agent with extracted markdown content
  if (agentContent) {
    return (
      <div className="border-t border-border pt-1.5 space-y-1">
        <MiniMarkdown content={agentContent} maxHeight="max-h-60" />
        {/* Toggle to show raw JSON */}
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
        >
          <Code className="size-3" />
          {showRaw ? "Hide" : "Show"} raw
        </button>
        {showRaw && (
          <pre className="overflow-x-auto text-text-subtle font-mono max-h-40 whitespace-pre-wrap break-all text-[10px]">
            {output}
          </pre>
        )}
      </div>
    );
  }

  // Default: collapsible raw output
  return (
    <CollapsibleOutput output={output} />
  );
}

/** Collapsible raw output — collapsed by default if > 3 lines */
function CollapsibleOutput({ output }: { output: string }) {
  const lineCount = output.split("\n").length;
  const isLong = lineCount > 3 || output.length > 200;
  const [collapsed, setCollapsed] = useState(isLong);

  return (
    <div className="border-t border-border pt-1.5">
      {isLong && (
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors mb-1"
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          Output ({lineCount} lines)
        </button>
      )}
      <pre className={`overflow-x-auto text-text-subtle font-mono whitespace-pre-wrap break-all ${
        collapsed ? "max-h-16 overflow-hidden" : "max-h-60"
      }`}>
        {output}
      </pre>
    </div>
  );
}

/** Render subagent child events — nested tool_use/tool_result + text */
function SubagentChildren({ events, projectName }: { events: ChatEvent[]; projectName?: string }) {
  // Group children similar to InterleavedEvents: pair tool_use + tool_result, merge text
  type ChildGroup =
    | { kind: "text"; content: string }
    | { kind: "tool"; tool: ChatEvent; result?: ChatEvent };

  const groups: ChildGroup[] = [];
  let textBuffer = "";

  for (const ev of events) {
    if (ev.type === "text") {
      textBuffer += ev.content;
    } else if (ev.type === "tool_use") {
      if (textBuffer) { groups.push({ kind: "text", content: textBuffer }); textBuffer = ""; }
      groups.push({ kind: "tool", tool: ev });
    } else if (ev.type === "tool_result") {
      // Match to last unmatched tool_use by toolUseId
      const trId = (ev as any).toolUseId;
      const match = trId
        ? groups.find((g) => g.kind === "tool" && g.tool.type === "tool_use" && (g.tool as any).toolUseId === trId && !g.result) as (ChildGroup & { kind: "tool" }) | undefined
        : groups.findLast((g) => g.kind === "tool" && !g.result) as (ChildGroup & { kind: "tool" }) | undefined;
      if (match) match.result = ev;
    }
  }
  if (textBuffer) groups.push({ kind: "text", content: textBuffer });

  return (
    <div className="border-l-2 border-accent/20 pl-2 space-y-1 mt-1">
      {groups.map((g, i) => {
        if (g.kind === "text") {
          return (
            <div key={`st-${i}`} className="text-text-secondary text-[11px]">
              <MiniMarkdown content={g.content} maxHeight="max-h-24" />
            </div>
          );
        }
        return <ToolCard key={`sc-${i}`} tool={g.tool} result={g.result} completed={!!(g.result)} projectName={projectName} />;
      })}
    </div>
  );
}

/** Inline markdown renderer for tool details (prompt, result) */
function MiniMarkdown({ content, maxHeight = "max-h-48" }: { content: string; maxHeight?: string }) {
  return <MarkdownRenderer content={content} className={`text-text-secondary overflow-auto ${maxHeight}`} />;
}


function truncate(str?: string, max = 50): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}
