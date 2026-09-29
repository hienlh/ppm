import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown, ChevronUp, Pin, PinOff, Search, X } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { formatRelativeDate } from "@/lib/format-date";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useProjectTags, TagChipBar } from "./tag-filter-chips";
import { SessionContextMenu } from "./session-context-menu";
import { ProviderBadge } from "./provider-selector";
import { useNotificationStore, notificationTint } from "@/stores/notification-store";
import { cn } from "@/lib/utils";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS, commitOptimistic } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { SessionListSyncIndicator } from "./session-list-sync-indicator";
import type { SessionInfo, ProjectTag } from "../../../types/chat";

const MAX_RECENT_SESSIONS = 5;
const FETCH_SESSIONS_LIMIT = 20;

interface SessionListPanelProps {
  projectName: string | undefined;
  onSelectSession: (session: SessionInfo) => void;
  className?: string;
}

export function SessionListPanel({ projectName, onSelectSession, className }: SessionListPanelProps) {
  return <ProjectSessionListPanel key={projectName} projectName={projectName} onSelectSession={onSelectSession} className={className} />;
}

function ProjectSessionListPanel({ projectName, onSelectSession, className }: SessionListPanelProps) {
  const project = useProjectRef(projectName);
  const id = project ? projectCacheId(project) : null;

  // Cached rows render on the first frame; the store syncs in the background
  // (deduplicated with every other reader of this project).
  useEffect(() => {
    if (project) void useSessionListStore.getState().ensure(project);
  }, [project]);
  const storeSessions = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);

  const [searchResults, setSearchResults] = useState<SessionInfo[] | null>(null);
  const requestRef = useRef(0);
  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const { projectTags, tagCounts, loadTags } = useProjectTags(projectName);

  // Server-side title search runs on its own request — the shared store only
  // ever holds the unfiltered first page.
  useEffect(() => {
    if (!projectName || !debouncedSearch) { setSearchResults(null); return; }
    const request = ++requestRef.current;
    (async () => {
      try {
        const params = new URLSearchParams({ limit: String(FETCH_SESSIONS_LIMIT), q: debouncedSearch });
        const data = await api.get<{ sessions: SessionInfo[]; hasMore: boolean }>(`${projectUrl(projectName)}/chat/sessions?${params}`);
        if (request !== requestRef.current) return;
        setSearchResults(data.sessions.slice(0, FETCH_SESSIONS_LIMIT));
      } catch {
        // silently ignore
      }
    })();
    return () => { ++requestRef.current; };
  }, [projectName, debouncedSearch]);

  const sessions = searchResults ?? storeSessions.slice(0, FETCH_SESSIONS_LIMIT);

  const togglePin = useCallback(async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    if (!project) return;
    const url = `${projectUrl(project.name)}/chat/sessions/${session.id}/pin`;
    const nextPinned = !session.pinned;
    const pinIn = (pinned: boolean) => setSearchResults((prev) =>
      prev ? prev.map((s) => s.id === session.id ? { ...s, pinned } : s) : prev);
    // Optimistic; a refused change re-syncs the store (`commitOptimistic`) and puts the
    // search page's row back as it was.
    useSessionListStore.getState().setPinned(project, session.id, nextPinned);
    pinIn(nextPinned);
    const ok = await commitOptimistic(project, () => (nextPinned ? api.put(url) : api.del(url)));
    if (!ok) pinIn(!nextPinned);
  }, [project]);

  const handleTagChanged = useCallback((sid: string, tag: { id: number; name: string; color: string } | null) => {
    if (project) useSessionListStore.getState().setSessionTag(project, sid, tag);
    setSearchResults((prev) => prev ? prev.map((s) => s.id === sid ? { ...s, tag } : s) : prev);
    loadTags();
  }, [loadTags, project]);

  // Tag filter is client-side; search is server-side via ?q=
  const filtered = selectedTagId !== null
    ? sessions.filter((s) => s.tag?.id === selectedTagId)
    : sessions;
  const pinnedSessions = filtered.filter((s) => s.pinned);
  const allRecentSessions = filtered.filter((s) => !s.pinned);
  const recentSessions = showAll ? allRecentSessions : allRecentSessions.slice(0, MAX_RECENT_SESSIONS);
  const hasMore = allRecentSessions.length > MAX_RECENT_SESSIONS;

  if (!projectName || (sessions.length === 0 && !searchQuery)) return null;

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
          <p className="text-xs text-text-subtle text-center">
            Recent chats
            {project && <SessionListSyncIndicator project={project} className="ml-1.5" />}
          </p>
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
  const notif = useNotificationStore((s) => s.notifications.get(session.id));
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
        className={cn(
          "group flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-surface-elevated active:bg-surface-elevated transition-colors border-b border-border/50 last:border-0",
          notif && notificationTint(notif.type),
        )}
      >
        <ProviderBadge providerId={session.providerId} />
        {session.tag && (
          <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
        )}
        <span className={cn("flex-1 min-w-0 text-xs truncate", notif ? "font-semibold text-foreground" : "font-medium text-text-primary")}>
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
