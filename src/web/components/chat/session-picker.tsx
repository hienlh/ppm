import { useState, useEffect, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { Plus, Trash2, MessageSquare, ChevronDown } from "lucide-react";
import type { SessionInfo } from "../../../types/chat";

interface SessionPickerProps {
  currentSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
  projectName?: string;
}

export function SessionPicker({
  currentSessionId,
  onSelectSession,
  onNewSession,
  projectName,
}: SessionPickerProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    try {
      const data = await api.get<SessionInfo[]>(`${projectUrl(projectName)}/chat/sessions`);
      setSessions(data);
    } catch {
      // Silently fail — sessions list is non-critical
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Reload when dropdown opens
  useEffect(() => {
    if (open) loadSessions();
  }, [open, loadSessions]);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  const handleDelete = async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    try {
      if (!projectName) return;
      await api.del(
        `${projectUrl(projectName)}/chat/sessions/${session.id}?providerId=${session.providerId}`,
      );
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    } catch {
      // Silently fail
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-surface-elevated"
      >
        <MessageSquare className="size-3.5" />
        <span className="truncate max-w-[150px]">
          {currentSession?.title ?? "Select chat"}
        </span>
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute bottom-full left-0 mb-1 z-50 w-64 rounded-lg border border-border bg-surface shadow-lg overflow-hidden">
            {/* New chat button */}
            <button
              onClick={() => {
                onNewSession();
                setOpen(false);
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-primary hover:bg-surface-elevated transition-colors border-b border-border"
            >
              <Plus className="size-4" />
              <span>New Chat</span>
            </button>

            {/* Sessions list */}
            <div className="max-h-60 overflow-y-auto">
              {loading && (
                <p className="px-3 py-2 text-xs text-text-subtle animate-pulse">
                  Loading sessions...
                </p>
              )}
              {!loading && sessions.length === 0 && (
                <p className="px-3 py-2 text-xs text-text-subtle">
                  No sessions yet
                </p>
              )}
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => {
                    onSelectSession(session);
                    setOpen(false);
                  }}
                  className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer hover:bg-surface-elevated transition-colors ${
                    session.id === currentSessionId
                      ? "bg-surface-elevated text-text-primary"
                      : "text-text-secondary"
                  }`}
                >
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate text-xs font-medium">
                      {session.title}
                    </span>
                    <span className="text-xs text-text-subtle">
                      {new Date(session.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, session)}
                    className="p-1 rounded hover:bg-red-500/20 text-text-subtle hover:text-red-400 transition-colors shrink-0"
                    aria-label="Delete session"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
