import { useEffect, useState, useCallback } from "react";
import { MessageSquare, Loader2, RefreshCw } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { formatRelativeDate } from "@/lib/format-date";
import type { SessionInfo } from "../../../types/chat";

interface ChatHistoryPanelProps {
  projectName?: string;
}

export function ChatHistoryPanel({ projectName }: ChatHistoryPanelProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openTab = useTabStore((s) => s.openTab);

  const load = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ sessions: SessionInfo[]; hasMore: boolean }>(`${projectUrl(projectName)}/chat/sessions`);
      setSessions(data.sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => { load(); }, [load]);

  if (!projectName) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-text-subtle px-4 text-center">
        Select a project to view chat history
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24">
        <Loader2 className="size-4 animate-spin text-text-subtle" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 p-4 text-xs text-text-subtle">
        <span>{error}</span>
        <button onClick={load} className="flex items-center gap-1 hover:text-text-secondary transition-colors">
          <RefreshCw className="size-3" /> Retry
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2 text-xs text-text-subtle">
        <MessageSquare className="size-5" />
        <span>No chat sessions yet</span>
      </div>
    );
  }

  function openSession(session: SessionInfo) {
    openTab({
      type: "chat",
      title: session.title || "Chat",
      projectId: projectName ?? null,
      metadata: { projectName, sessionId: session.id },
      closable: true,
    });
  }

  return (
    <div className="flex flex-col">
      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => openSession(session)}
          className="flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-elevated transition-colors border-b border-border/50 last:border-0"
        >
          <MessageSquare className="size-3.5 shrink-0 mt-0.5 text-text-subtle" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate text-text-primary">{session.title || "Untitled"}</p>
            {session.updatedAt && (
              <p className="text-[10px] text-text-subtle">{formatRelativeDate(session.updatedAt)}</p>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
