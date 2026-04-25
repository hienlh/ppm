import { useState, useEffect, useCallback, useRef } from "react";
import { History, Settings2, Loader2, MessageSquare, RefreshCw, Search, Pencil, Check, X, BellOff, Bug, ClipboardCheck, Pin, PinOff, Trash2, Users, Bot, Tags, CalendarX2 } from "lucide-react";
import { Activity } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { useNotificationStore } from "@/stores/notification-store";
import { AISettingsSection } from "@/components/settings/ai-settings-section";
import { TagSettingsSection } from "@/components/settings/tag-settings-section";
import { SessionContextMenu } from "./session-context-menu";
import { UsageDetailPanel } from "./usage-badge";
import { TeamActivityPanel } from "./team-activity-panel";
import { ProviderBadge } from "./provider-selector";
import { formatRelativeDate } from "@/lib/format-date";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { SessionInfo, SessionListResponse, ProjectTag } from "../../../types/chat";
import type { UsageInfo } from "../../../types/chat";
import type { TeamMessageItem } from "@/hooks/use-chat";

type PanelType = "history" | "config" | "usage" | "team" | null;

interface TeamActivityState {
  hasTeams: boolean;
  teamNames: string[];
  messageCount: number;
  unreadCount: number;
}

interface ChatHistoryBarProps {
  projectName: string;
  usageInfo: UsageInfo;
  usageLoading?: boolean;
  refreshUsage?: () => void;
  lastFetchedAt?: string | null;
  sessionId?: string | null;
  providerId?: string;
  onSelectSession?: (session: SessionInfo) => void;
  onBugReport?: () => void;
  isConnected?: boolean;
  onReconnect?: () => void;
  teamActivity?: TeamActivityState;
  teamMessages?: TeamMessageItem[];
  onTeamOpen?: () => void;
}

function relativeTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-amber-500";
  return "text-green-500";
}

function DebugCopyButton({ sessionId, projectName }: { sessionId: string; projectName: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        try {
          // Use ClipboardItem with pending promise so Safari doesn't lose user gesture
          const textPromise = api.get<{ ppmSessionId: string; sdkSessionId: string; jsonlPath: string | null; projectPath: string }>(
            `${projectUrl(projectName)}/chat/sessions/${sessionId}/debug?project=${encodeURIComponent(projectName)}`,
          ).then((data) => {
            const info = [
              `PPM Session: ${data.ppmSessionId}`,
              `SDK Session: ${data.sdkSessionId}`,
              data.jsonlPath ? `JSONL: ${data.jsonlPath}` : `JSONL: not found`,
              data.projectPath ? `Project: ${data.projectPath}` : null,
            ].filter(Boolean).join("\n");
            return new Blob([info], { type: "text/plain" });
          });
          navigator.clipboard.write([new ClipboardItem({ "text/plain": textPromise })]).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        } catch { /* silent */ }
      }}
      className={`p-1 rounded transition-colors ${copied ? "text-green-500 bg-green-500/10" : "text-text-subtle hover:text-text-secondary hover:bg-surface-elevated"}`}
      title={copied ? "Copied!" : "Copy session debug info"}
    >
      {copied ? <ClipboardCheck className="size-3" /> : <Bug className="size-3" />}
    </button>
  );
}

export function ChatHistoryBar({
  projectName, usageInfo, usageLoading, refreshUsage, lastFetchedAt,
  sessionId, providerId, onSelectSession, onBugReport, isConnected, onReconnect,
  teamActivity, teamMessages, onTeamOpen,
}: ChatHistoryBarProps) {
  const [activePanel, setActivePanel] = useState<PanelType>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const hasUnread = useNotificationStore((s) => sessionId ? s.notifications.has(sessionId) : false);
  const clearForSession = useNotificationStore((s) => s.clearForSession);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectTags, setProjectTags] = useState<ProjectTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [tagCounts, setTagCounts] = useState<Record<number, number>>({});
  const [showTagSettings, setShowTagSettings] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const openTab = useTabStore((s) => s.openTab);
  const PAGE_SIZE = 50;

  const togglePanel = (panel: PanelType) => {
    setActivePanel((prev) => prev === panel ? null : panel);
  };

  const load = useCallback(async (query?: string) => {
    if (!projectName) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: "0" });
      if (query) params.set("q", query);
      const data = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`);
      setSessions(data.sessions);
      setHasMore(data.hasMore);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  const loadMore = useCallback(async () => {
    if (!projectName || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      // Offset by count of non-pinned sessions (pinned are injected separately by backend)
      const unpinnedCount = sessions.filter((s) => !s.pinned).length;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(unpinnedCount) });
      if (debouncedSearch) params.set("q", debouncedSearch);
      const data = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`);
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = data.sessions.filter((s) => !existingIds.has(s.id));
        return [...prev, ...newSessions];
      });
      setHasMore(data.hasMore);
    } catch {
      // silent
    } finally {
      setLoadingMore(false);
    }
  }, [projectName, loadingMore, hasMore, sessions, debouncedSearch]);

  // Load sessions when history panel opens
  useEffect(() => {
    if (activePanel === "history" && sessions.length === 0) load();
  }, [activePanel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when debounced search query changes (server-side search)
  useEffect(() => {
    if (activePanel === "history") load(debouncedSearch || undefined);
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch tags
  const loadTags = useCallback(async () => {
    if (!projectName) return;
    try {
      const data = await api.get<{ tags: ProjectTag[]; counts: Record<number, number> }>(
        `${projectUrl(projectName)}/tags`,
      );
      setProjectTags(data.tags);
      setTagCounts(data.counts);
    } catch { /* silent */ }
  }, [projectName]);

  useEffect(() => {
    if (activePanel === "history" && projectName) loadTags();
  }, [activePanel, projectName, loadTags]);

  function openSession(session: SessionInfo) {
    if (onSelectSession) {
      onSelectSession(session);
      setActivePanel(null);
    } else {
      openTab({
        type: "chat",
        title: session.title || "Chat",
        projectId: projectName ?? null,
        metadata: { projectName, sessionId: session.id, providerId: session.providerId },
        closable: true,
      });
    }
  }

  const startEditing = useCallback((session: SessionInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditingTitle(session.title || "");
    setTimeout(() => editInputRef.current?.select(), 0);
  }, []);

  const saveTitle = useCallback(async () => {
    if (!editingId || !editingTitle.trim() || !projectName) {
      setEditingId(null);
      return;
    }
    try {
      await api.patch(`${projectUrl(projectName)}/chat/sessions/${editingId}`, { title: editingTitle.trim() });
      setSessions((prev) => prev.map((s) => s.id === editingId ? { ...s, title: editingTitle.trim() } : s));
    } catch { /* silent */ }
    setEditingId(null);
  }, [editingId, editingTitle, projectName]);

  const cancelEditing = useCallback(() => setEditingId(null), []);

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
    } catch { /* silent */ }
  }, [projectName]);

  const deleteSession = useCallback(async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    if (!projectName) return;
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
    try {
      await api.del(`${projectUrl(projectName)}/chat/sessions/${session.id}?providerId=${session.providerId}`);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    } catch { /* silent */ }
  }, [projectName]);

  const handleTagChanged = useCallback((sid: string, tag: { id: number; name: string; color: string } | null) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, tag } : s));
    loadTags(); // Refetch counts from API for accuracy
  }, [loadTags]);

  const bulkDelete = useCallback(async () => {
    if (!projectName) return;
    const days = window.prompt("Delete sessions older than how many days? (pinned sessions are kept)", "30");
    if (!days) return;
    const num = parseInt(days, 10);
    if (!num || num < 1) return;
    if (!window.confirm(`Delete all unpinned sessions older than ${num} days? This cannot be undone.`)) return;
    setLoading(true);
    try {
      await api.del(`${projectUrl(projectName)}/chat/sessions?olderThanDays=${num}`);
      load(debouncedSearch || undefined);
    } catch { /* silent */ }
  }, [projectName, load, debouncedSearch]);

  // Keyboard shortcuts: 1-9 to assign tags to current session
  useEffect(() => {
    if (activePanel !== "history") return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= projectTags.length && sessionId) {
        const tag = projectTags[num - 1];
        if (tag) {
          api.patch(`${projectUrl(projectName)}/chat/sessions/${sessionId}/tag`, { tagId: tag.id }).catch(() => {});
          handleTagChanged(sessionId, { id: tag.id, name: tag.name, color: tag.color });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePanel, projectTags, sessionId, projectName, handleTagChanged]);

  // Filter by tag client-side (search is now server-side via ?q=)
  const filteredSessions = selectedTagId !== null
    ? sessions.filter((s) => s.tag?.id === selectedTagId)
    : sessions;

  // Usage badge display — only meaningful for Claude (SDK) provider
  const isClaudeProvider = !providerId || providerId === "claude";
  const fiveHourPct = usageInfo.fiveHour != null ? Math.round(usageInfo.fiveHour * 100) : null;
  const sevenDayPct = usageInfo.sevenDay != null ? Math.round(usageInfo.sevenDay * 100) : null;
  const worstPct = Math.max(fiveHourPct ?? 0, sevenDayPct ?? 0);
  const usageColor = fiveHourPct != null || sevenDayPct != null ? pctColor(worstPct) : "text-text-subtle";

  return (
    <div className="border-b border-border/50">
      {/* Toolbar row — all buttons on one line */}
      <div className="flex items-center gap-1 px-2 py-1">
        {/* History */}
        <button
          onClick={() => togglePanel("history")}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
            activePanel === "history" ? "text-primary bg-primary/10" : "text-text-secondary hover:text-foreground hover:bg-surface-elevated"
          }`}
        >
          <History className="size-3" />
          <span>History</span>
        </button>

        {/* Active provider + AI Settings (combined) */}
        {sessionId && providerId && providerId !== "mock" ? (
          <button
            onClick={() => togglePanel("config")}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
              activePanel === "config" ? "text-primary bg-primary/10" : "text-text-secondary hover:text-foreground hover:bg-surface-elevated"
            }`}
            title="AI Settings"
          >
            <ProviderBadge providerId={providerId} />
            <span className="capitalize">{providerId}</span>
          </button>
        ) : (
          <button
            onClick={() => togglePanel("config")}
            className={`p-1 rounded transition-colors ${
              activePanel === "config" ? "text-primary bg-primary/10" : "text-text-subtle hover:text-text-secondary hover:bg-surface-elevated"
            }`}
            title="AI Settings"
          >
            <Settings2 className="size-3" />
          </button>
        )}

        {/* Usage & Accounts — full display for Claude, minimal for other providers */}
        {isClaudeProvider ? (
          <button
            onClick={() => togglePanel("usage")}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors hover:bg-surface-elevated ${
              activePanel === "usage" ? "bg-primary/10" : ""
            } ${usageColor}`}
            title="Usage limits"
          >
            <Activity className="size-3" />
            {usageInfo.activeAccountLabel && (
              <span className="text-text-secondary font-normal truncate max-w-[60px]">[{usageInfo.activeAccountLabel}]</span>
            )}
            <span>5h:{fiveHourPct != null ? `${fiveHourPct}%` : "--%"}</span>
            <span className="text-text-subtle">·</span>
            <span>Wk:{sevenDayPct != null ? `${sevenDayPct}%` : "--%"}</span>
          </button>
        ) : null}

        {/* Team activity */}
        {teamActivity?.hasTeams && (
          <button
            onClick={() => {
              togglePanel("team");
              onTeamOpen?.();
            }}
            className={`relative flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
              activePanel === "team" ? "text-primary bg-primary/10" : "text-text-secondary hover:text-foreground hover:bg-surface-elevated"
            }`}
            title="Team activity"
          >
            <Users className="size-3" />
            <span>Team</span>
            {(teamActivity.unreadCount ?? 0) > 0 && (
              <span className="absolute -top-0.5 -right-0.5 size-2 bg-primary rounded-full animate-pulse" />
            )}
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Mark as read */}
        {hasUnread && sessionId && (
          <button
            onClick={() => clearForSession(sessionId)}
            className="p-1 rounded text-amber-500 hover:text-amber-400 hover:bg-surface-elevated transition-colors"
            title="Mark as read"
          >
            <BellOff className="size-3" />
          </button>
        )}

        {/* Debug info — copy session IDs + JSONL path */}
        {sessionId && (
          <DebugCopyButton sessionId={sessionId} projectName={projectName} />
        )}

        {/* Connection indicator */}
        {onReconnect && (
          <button
            onClick={onReconnect}
            className="size-4 flex items-center justify-center"
            title={isConnected ? "Connected" : "Disconnected — click to reconnect"}
          >
            <span className={`size-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
          </button>
        )}
      </div>

      {/* Panels — only one visible at a time */}

      {/* History panel */}
      {activePanel === "history" && (
        <div className="border-t border-border/30 bg-surface">
          {/* Search + refresh */}
          <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/30">
            <Search className="size-3 text-text-subtle shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              className="flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-subtle"
            />
            <button
              onClick={bulkDelete}
              className="p-0.5 rounded text-text-subtle hover:text-red-400 transition-colors"
              title="Delete old sessions..."
            >
              <CalendarX2 className="size-3" />
            </button>
            <button
              onClick={() => load(debouncedSearch || undefined)}
              disabled={loading}
              className="p-0.5 rounded text-text-subtle hover:text-text-secondary transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* Tag filter chips */}
          {projectTags.length > 0 && (
            <div className="flex items-center gap-1 px-2 py-1 overflow-x-auto border-b border-border/30 scrollbar-none">
              <button
                onClick={() => setSelectedTagId(null)}
                className={`shrink-0 rounded-md border px-2 py-1 text-[10px] transition-colors ${
                  selectedTagId === null ? "bg-primary/20 border-primary text-primary" : "border-border bg-surface text-text-secondary"
                }`}
              >All ({sessions.length})</button>
              {projectTags.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => setSelectedTagId(selectedTagId === tag.id ? null : tag.id)}
                  className={`shrink-0 flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors ${
                    selectedTagId === tag.id ? "border-current" : "border-border bg-surface"
                  }`}
                  style={selectedTagId === tag.id ? { backgroundColor: tag.color + "20", color: tag.color, borderColor: tag.color } : undefined}
                >
                  <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                  {tag.name} ({tagCounts[tag.id] ?? 0})
                </button>
              ))}
              <button
                onClick={() => setShowTagSettings(!showTagSettings)}
                className={`shrink-0 p-1 rounded transition-colors ${showTagSettings ? "text-primary bg-primary/10" : "text-text-subtle hover:text-text-secondary"}`}
                title="Manage tags"
              >
                <Tags className="size-3" />
              </button>
            </div>
          )}

          {/* Tag management panel (inline) */}
          {showTagSettings && (
            <div className="border-b border-border/30 px-2 py-2 max-h-[180px] overflow-y-auto bg-surface-elevated/50">
              <TagSettingsSection projectName={projectName} onTagsChanged={loadTags} />
            </div>
          )}

          <div className="max-h-[200px] overflow-y-auto">
            {loading && sessions.length === 0 ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="size-3.5 animate-spin text-text-subtle" />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex items-center justify-center py-3 text-[11px] text-text-subtle">
                {searchQuery ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              <>
                {filteredSessions.map((session) => (
                  <SessionContextMenu
                    key={session.id}
                    session={session}
                    projectName={projectName}
                    projectTags={projectTags}
                    onTogglePin={togglePin}
                    onStartEditing={startEditing}
                    onDeleteSession={deleteSession}
                    onTagChanged={handleTagChanged}
                  >
                  <div
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-surface-elevated transition-colors group"
                  >
                    <ProviderBadge providerId={session.providerId} />
                    {session.tag && (
                      <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
                    )}
                    {editingId === session.id ? (
                      <form
                        className="flex items-center gap-1 flex-1 min-w-0"
                        onSubmit={(e) => { e.preventDefault(); saveTitle(); }}
                      >
                        <input
                          ref={editInputRef}
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onBlur={saveTitle}
                          onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
                          className="flex-1 min-w-0 bg-surface-elevated text-[11px] text-text-primary px-1 py-0.5 rounded border border-border outline-none focus:border-primary"
                          autoFocus
                        />
                        <button type="submit" className="p-0.5 text-green-500 hover:text-green-400" onClick={(e) => e.stopPropagation()}>
                          <Check className="size-3" />
                        </button>
                        <button type="button" className="p-0.5 text-text-subtle hover:text-text-secondary" onClick={(e) => { e.stopPropagation(); cancelEditing(); }}>
                          <X className="size-3" />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          onClick={() => openSession(session)}
                          className="text-[11px] truncate flex-1 text-left flex items-center gap-1"
                        >
                          {session.title?.startsWith("[PPM]") && (
                            <Bot className="size-3 text-muted-foreground shrink-0" />
                          )}
                          {session.title?.startsWith("[PPM]")
                            ? session.title.slice(7)
                            : session.title || "Untitled"}
                        </button>
                        <button
                          onClick={(e) => togglePin(e, session)}
                          className={`p-0.5 rounded transition-all ${
                            session.pinned
                              ? "text-primary hover:text-primary/70"
                              : "text-text-subtle hover:text-text-secondary can-hover:opacity-0 can-hover:group-hover:opacity-100"
                          }`}
                          title={session.pinned ? "Unpin session" : "Pin session"}
                        >
                          {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                        </button>
                        <button
                          onClick={(e) => startEditing(session, e)}
                          className="p-0.5 rounded text-text-subtle hover:text-text-secondary can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity"
                          title="Rename session"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          onClick={(e) => deleteSession(e, session)}
                          className="p-0.5 rounded text-text-subtle hover:text-red-400 hover:bg-red-500/20 can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity"
                          title="Delete session"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </>
                    )}
                    {editingId !== session.id && session.updatedAt && (
                      <span className="text-[10px] text-text-subtle shrink-0 w-16 text-right">{formatRelativeDate(session.updatedAt)}</span>
                    )}
                  </div>
                  </SessionContextMenu>
                ))}
                {hasMore && (
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="flex items-center justify-center gap-1 w-full py-1.5 text-[11px] text-text-subtle hover:text-text-secondary hover:bg-surface-elevated transition-colors"
                  >
                    {loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
                    {loadingMore ? "Loading..." : "Load more"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Config panel */}
      {activePanel === "config" && (
        <div className="border-t border-border/30 bg-surface px-3 py-2 max-h-[280px] overflow-y-auto">
          <AISettingsSection compact />
        </div>
      )}

      {/* Team activity panel */}
      {activePanel === "team" && teamActivity?.hasTeams && (
        <div className="border-t border-border/30 bg-surface px-3 py-2 max-h-[280px] overflow-y-auto">
          <TeamActivityPanel
            teamNames={teamActivity.teamNames}
            messages={teamMessages ?? []}
          />
        </div>
      )}

      {/* Usage panel — only for Claude provider */}
      {activePanel === "usage" && isClaudeProvider && (
        <UsageDetailPanel
          usage={usageInfo}
          visible={true}
          onClose={() => setActivePanel(null)}
          onReload={refreshUsage}
          loading={usageLoading}
          lastFetchedAt={lastFetchedAt}
        />
      )}

    </div>
  );
}
