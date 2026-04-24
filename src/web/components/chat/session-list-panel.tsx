import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp, MessageSquare, Pin, PinOff, Search, X } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { formatRelativeDate } from "@/lib/format-date";
import { useProjectTags, TagChipBar } from "./tag-filter-chips";
import { SessionContextMenu } from "./session-context-menu";
import type { SessionInfo, ProjectTag } from "../../../types/chat";

const MAX_RECENT_SESSIONS = 5;
const FETCH_SESSIONS_LIMIT = 20;

interface SessionListPanelProps {
  projectName: string | undefined;
  onSelectSession: (session: SessionInfo) => void;
  className?: string;
}

export function SessionListPanel({ projectName, onSelectSession, className }: SessionListPanelProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const { projectTags, tagCounts, loadTags } = useProjectTags(projectName);

  const loadSessions = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    try {
      const data = await api.get<{ sessions: SessionInfo[]; hasMore: boolean }>(`${projectUrl(projectName)}/chat/sessions?limit=${FETCH_SESSIONS_LIMIT}`);
      setSessions(data.sessions.slice(0, FETCH_SESSIONS_LIMIT));
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

  const handleTagChanged = useCallback((sid: string, tag: { id: number; name: string; color: string } | null) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, tag } : s));
    loadTags();
  }, [loadTags]);

  const query = searchQuery.toLowerCase().trim();
  const filtered = sessions.filter((s) => {
    if (selectedTagId !== null && s.tag?.id !== selectedTagId) return false;
    if (query && !(s.title || "").toLowerCase().includes(query)) return false;
    return true;
  });
  const pinnedSessions = filtered.filter((s) => s.pinned);
  const allRecentSessions = filtered.filter((s) => !s.pinned);
  const recentSessions = showAll ? allRecentSessions : allRecentSessions.slice(0, MAX_RECENT_SESSIONS);
  const hasMore = allRecentSessions.length > MAX_RECENT_SESSIONS;

  if (loading || !projectName || sessions.length === 0) return null;

  return (
    <div className={className}>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-subtle pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search chats..."
          className="w-full pl-8 pr-8 py-1.5 text-xs rounded-md border border-border bg-surface text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-subtle hover:text-text-primary">
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="mt-3">
        <TagChipBar projectTags={projectTags} tagCounts={tagCounts} totalCount={sessions.length} selectedTagId={selectedTagId} onSelect={setSelectedTagId} />
      </div>

      {pinnedSessions.length > 0 && (
        <div className="flex flex-col gap-2 w-full mt-4">
          <p className="text-xs text-text-subtle text-center">Pinned</p>
          <div className="w-full rounded-md border border-border bg-surface overflow-hidden">
            {pinnedSessions.map((s) => (
              <SessionRow key={s.id} session={s} projectName={projectName} projectTags={projectTags} onSelect={onSelectSession} onTogglePin={togglePin} onTagChanged={handleTagChanged} />
            ))}
          </div>
        </div>
      )}

      {recentSessions.length > 0 && (
        <div className="flex flex-col gap-2 w-full mt-4">
          <p className="text-xs text-text-subtle text-center">Recent chats</p>
          <div className="w-full rounded-md border border-border bg-surface overflow-hidden">
            {recentSessions.map((s) => (
              <SessionRow key={s.id} session={s} projectName={projectName} projectTags={projectTags} onSelect={onSelectSession} onTogglePin={togglePin} onTagChanged={handleTagChanged} />
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="flex items-center justify-center gap-1 text-[11px] text-text-subtle hover:text-text-primary transition-colors py-1"
            >
              {showAll ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {showAll ? "Show less" : `Show more (${allRecentSessions.length - MAX_RECENT_SESSIONS})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  session: SessionInfo;
  projectName: string;
  projectTags: ProjectTag[];
  onSelect: (session: SessionInfo) => void;
  onTogglePin: (e: React.MouseEvent, session: SessionInfo) => void;
  onTagChanged: (sid: string, tag: { id: number; name: string; color: string } | null) => void;
}

function SessionRow({ session, projectName, projectTags, onSelect, onTogglePin, onTagChanged }: SessionRowProps) {
  return (
    <SessionContextMenu
      session={session}
      projectName={projectName}
      projectTags={projectTags}
      onTogglePin={onTogglePin}
      onTagChanged={onTagChanged}
    >
      <button
        onClick={() => onSelect(session)}
        className="group flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-surface-elevated active:bg-surface-elevated transition-colors border-b border-border/50 last:border-0"
      >
        <MessageSquare className="size-3.5 shrink-0 text-text-subtle" />
        {session.tag && (
          <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
        )}
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
          onClick={(e) => onTogglePin(e, session)}
          className={`p-1 rounded transition-colors shrink-0 ${
            session.pinned
              ? "text-primary hover:text-primary/70"
              : "text-text-subtle can-hover:opacity-0 can-hover:group-hover:opacity-100 hover:text-text-primary"
          }`}
          aria-label={session.pinned ? "Unpin session" : "Pin session"}
        >
          {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </span>
      </button>
    </SessionContextMenu>
  );
}
