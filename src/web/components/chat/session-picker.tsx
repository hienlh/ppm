import { useState, useEffect, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { Plus, Trash2, MessageSquare, ChevronDown, Pin, PinOff } from "lucide-react";
import { ProviderBadge } from "./provider-selector";
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
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
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

  const handleTogglePin = async (e: React.MouseEvent, session: SessionInfo) => {
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
      // Silently fail
    }
  };

  function renderSessionRow(session: SessionInfo) {
    return (
      <div
        key={session.id}
        onClick={() => {
          onSelectSession(session);
          setOpen(false);
        }}
        className={`group flex items-center justify-between px-3 py-2 text-sm cursor-pointer hover:bg-surface-elevated transition-colors ${
          session.id === currentSessionId
            ? "bg-surface-elevated text-text-primary"
            : "text-text-secondary"
        }`}
      >
        <div className="flex flex-col min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate text-xs font-medium">
            <ProviderBadge providerId={session.providerId} />
            {session.title}
          </span>
          <span className="text-xs text-text-subtle">
            {new Date(session.createdAt).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => handleTogglePin(e, session)}
            className={`p-1 rounded transition-colors ${
              session.pinned
                ? "text-primary hover:text-primary/70"
                : "text-text-subtle md:opacity-0 md:group-hover:opacity-100 hover:text-text-primary"
            }`}
            aria-label={session.pinned ? "Unpin session" : "Pin session"}
          >
            {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          </button>
          <button
            onClick={(e) => handleDelete(e, session)}
            className="p-1 rounded hover:bg-red-500/20 text-text-subtle hover:text-red-400 transition-colors md:opacity-0 md:group-hover:opacity-100"
            aria-label="Delete session"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
    );
  }

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
              {sessions.filter((s) => s.pinned).length > 0 && (
                <p className="px-3 py-1 text-[10px] text-text-subtle uppercase tracking-wider bg-surface">Pinned</p>
              )}
              {sessions.filter((s) => s.pinned).map((session) => renderSessionRow(session))}
              {sessions.filter((s) => s.pinned).length > 0 && sessions.filter((s) => !s.pinned).length > 0 && (
                <div className="border-t border-border" />
              )}
              {sessions.filter((s) => !s.pinned).map((session) => renderSessionRow(session))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
