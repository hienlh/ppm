import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronRight, Eye, FileCode, Loader2, XCircle } from "@/lib/icons";
import { basename } from "@/lib/utils";
import { openAiTab, resolveToolCallTarget } from "@/lib/open-ai-tab";
import { previewProblemCount, tabToolResultText, type TabToolCall } from "@/lib/tab-tool-call";
import { useAgentSessionContext } from "./agent-session-context";

/**
 * The card for the AI's tab tools: what was opened, what the page check found, and an Open
 * button that brings the tab back — from the chat's history, after the tab was closed, or on
 * a device that was not the one the AI opened it on. The screenshot the AI received is not in
 * the chat's history (images are stripped from tool results), so the button shows the live
 * page instead.
 */
export function TabToolCard({ call, toolUseId, output, isError, done, projectName }: {
  call: TabToolCall;
  toolUseId?: string;
  /** The tool result's raw output, once there is one. */
  output?: string;
  isError: boolean;
  done: boolean;
  projectName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const session = useAgentSessionContext();
  const text = output === undefined ? "" : tabToolResultText(output);
  const problems = call.tool === "open_preview" && !isError ? previewProblemCount(text) : null;
  const name = basename(call.path);
  const Icon = call.tool === "open_preview" ? Eye : FileCode;

  const open = async () => {
    const chatProject = session?.projectName || projectName;
    try {
      const target = await resolveToolCallTarget(call, chatProject);
      openAiTab(target, { sessionId: session?.sessionId ?? "", projectName: chatProject });
    } catch (e) {
      toast.error(`Could not open ${name}`, { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div data-tool-ref={toolUseId} className="rounded-[11px] border border-border overflow-hidden text-xs bg-panel">
      <div className="flex items-center min-w-0">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex items-center gap-2.5 px-2.5 py-2 flex-1 min-w-0 text-left hover:bg-panel-2/40 transition-colors max-md:min-h-11"
        >
          <span className="inline-flex items-center justify-center size-6 rounded-[7px] shrink-0 bg-info/15 text-info">
            <Icon className="size-3.5" />
          </span>
          <span className="truncate text-text font-medium">
            {call.tool === "open_preview" ? "Preview" : "Opened"}
            <span className="text-text-subtle"> · {name}{call.line ? `:${call.line}` : ""}</span>
          </span>
          <span className="ml-auto flex items-center gap-2 shrink-0">
            {problems !== null && (
              <span className={`text-[10px] ${problems > 0 ? "text-warning" : "text-text-3"}`}>
                {problems === 0 ? "no problems" : `${problems} ${problems === 1 ? "problem" : "problems"}`}
              </span>
            )}
            {isError
              ? <XCircle className="size-3.5 text-error" />
              : done
                ? <CheckCircle2 className="size-3.5 text-success" />
                : <Loader2 className="size-3.5 text-primary animate-spin" />}
            {expanded ? <ChevronDown className="size-3 text-text-3" /> : <ChevronRight className="size-3 text-text-3" />}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void open()}
          title={`Open ${name} in a tab`}
          className="shrink-0 mr-1 px-2.5 h-7 rounded-md text-primary font-medium hover:bg-accent-wash transition-colors max-md:h-11 max-md:min-w-11"
        >
          Open
        </button>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2 select-text">
          <p className="text-text-subtle font-mono break-all">{call.path}</p>
          {text && (
            <pre className="mt-1.5 border-t border-border pt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words text-text-subtle font-mono">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
