import { useState, useEffect, useCallback } from "react";
import { Bot, MessageSquare, Pin, PinOff } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import type { SessionInfo } from "../../../types/chat";

const MAX_RECENT_SESSIONS = 5;

function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

interface ChatWelcomeProps {
  projectName: string;
  onSelectSession: (session: SessionInfo) => void;
}

export function ChatWelcome({ projectName, onSelectSession }: ChatWelcomeProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    try {
      const data = await api.get<SessionInfo[]>(`${projectUrl(projectName)}/chat/sessions`);
      setSessions(data.slice(0, MAX_RECENT_SESSIONS));
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const togglePin = useCallback(async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    if (!projectName) return;
    const url = `${projectUrl(projectName)}/chat/sessions/${session.id}/pin`;
    try {
      if (session.pinned) {
        await api.del(url);
      } else {
        await api.put(url);
      }
      setSessions((prev) => {
        const updated = prev.map((s) => s.id === session.id ? { ...s, pinned: !s.pinned } : s);
        return updated.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
      });
    } catch {
      // silently ignore
    }
  }, [projectName]);

  const pinnedSessions = sessions.filter((s) => s.pinned);
  const recentSessions = sessions.filter((s) => !s.pinned).slice(0, MAX_RECENT_SESSIONS);

  function renderSessionRow(session: SessionInfo) {
    return (
      <button
        key={session.id}
        onClick={() => onSelectSession(session)}
        className="group flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-surface-elevated active:bg-surface-elevated transition-colors border-b border-border/50 last:border-0"
      >
        <MessageSquare className="size-3.5 shrink-0 text-text-subtle" />
        <span className="flex-1 min-w-0 text-xs font-medium truncate text-text-primary">
          {session.title || "Untitled"}
        </span>
        {session.updatedAt && (
          <span className="text-[10px] text-text-subtle shrink-0">
            {formatRelativeDate(session.updatedAt)}
          </span>
        )}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => togglePin(e, session)}
          className={`p-1 rounded transition-colors shrink-0 ${
            session.pinned
              ? "text-primary hover:text-primary/70"
              : "text-text-subtle md:opacity-0 md:group-hover:opacity-100 hover:text-text-primary"
          }`}
          aria-label={session.pinned ? "Unpin session" : "Pin session"}
        >
          {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-text-secondary overflow-y-auto">
      <div className="flex flex-col items-center gap-3">
        <Bot className="size-10 text-text-subtle" />
        <p className="text-sm">Send a message to start a new conversation</p>
      </div>

      {!loading && pinnedSessions.length > 0 && (
        <div className="flex flex-col gap-2 w-full max-w-sm px-4">
          <p className="text-xs text-text-subtle text-center">Pinned</p>
          <div className="w-full rounded-md border border-border bg-surface overflow-hidden">
            {pinnedSessions.map(renderSessionRow)}
          </div>
        </div>
      )}

      {!loading && recentSessions.length > 0 && (
        <div className="flex flex-col gap-2 w-full max-w-sm px-4">
          <p className="text-xs text-text-subtle text-center">Recent chats</p>
          <div className="w-full rounded-md border border-border bg-surface overflow-hidden">
            {recentSessions.map(renderSessionRow)}
          </div>
        </div>
      )}
    </div>
  );
}
