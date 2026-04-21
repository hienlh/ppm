import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import type { ChatMessage } from "../../../types/chat";
import { PreCompactButton, type PreCompactStatus } from "./pre-compact-button";

interface PreCompactSectionProps {
  jsonlPath: string;
  projectName?: string;
  /** Renders each loaded pre-compact message. Passed from parent to avoid circular imports. */
  renderMessage: (msg: ChatMessage, idx: number) => React.ReactNode;
}

/**
 * Orchestrates the "Load previous conversation" flow:
 * 1. Shows button when idle/loading/error
 * 2. On click: GET /api/project/:name/chat/pre-compact-messages?jsonlPath=...
 * 3. Renders returned messages in a collapsible section
 */
export function PreCompactSection({ jsonlPath, projectName, renderMessage }: PreCompactSectionProps) {
  const [status, setStatus] = useState<PreCompactStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const handleLoad = useCallback(async () => {
    if (!projectName) { setError("No project context available"); setStatus("error"); return; }
    setStatus("loading");
    setError(null);
    try {
      const path = `${projectUrl(projectName)}/chat/pre-compact-messages?jsonlPath=${encodeURIComponent(jsonlPath)}`;
      const data = await api.get<ChatMessage[]>(path);
      setMessages(data);
      setStatus("loaded");
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setStatus("error");
    }
  }, [jsonlPath, projectName]);

  if (status !== "loaded" || !messages) {
    return (
      <div className="mt-2 flex flex-col gap-1">
        <PreCompactButton status={status} onLoad={status === "loading" ? undefined : handleLoad} />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-surface/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-text-secondary hover:bg-surface/50 transition-colors min-h-[44px]"
      >
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <History className="size-4" />
        <span>Previous conversation ({messages.length} messages)</span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-2 md:px-3 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          {messages.map((msg, idx) => renderMessage(msg, idx))}
        </div>
      )}
    </div>
  );
}
