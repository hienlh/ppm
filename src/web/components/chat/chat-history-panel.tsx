/**
 * The chat's session history, opened from the History button in the footer's context row: search,
 * tag filters, and every past session of the project, each one tap from being reopened here.
 *
 * Mounted only while open. A search starts afresh each time it opens; the list itself comes from
 * the project's shared session store, so opening it costs no request of its own.
 */
import { usePanelStore } from "@/stores/panel-store";
import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, RefreshCw, Search, Pencil, Check, X, Pin, PinOff, Trash2, Bot, Tags, CalendarX2 } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { openSessionInItsTab } from "@/lib/design/open-design-tab";
import { useNotificationStore, notificationTint } from "@/stores/notification-store";
import { cn } from "@/lib/utils";
import { TagSettingsSection } from "@/components/settings/tag-settings-section";
import { SessionContextMenu } from "./session-context-menu";
import { ProviderBadge } from "./provider-selector";
import { SpawnedSessionBadge } from "./spawned-session-badge";
import { ManagerChatBadge } from "./manager-chat-badge";
import { formatRelativeDate } from "@/lib/format-date";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS, commitOptimistic } from "@/stores/session-list-store";
import { projectRefForName, useProjectRef } from "@/stores/session-list-sync-triggers";
import { sortSessions, removeSession, renameSession, setPinned, setSessionTag } from "@/lib/session-list-merge";
import type { SessionInfo, SessionListResponse } from "../../../types/chat";

export interface ChatHistoryPanelProps {
  tabId?: string;
  projectName: string;
  sessionId?: string | null;
  onSelectSession?: (session: SessionInfo) => void;
  /**
   * Set inside a design tab: only that design's sessions are listed, and picking one swaps
   * it into the tab. Without it, a design session is opened in its own design tab rather
   * than switched into this chat, where it would have left design mode.
   */
  historyFilter?: string;
  /** A session was opened: the panel has done its job. */
  onClose: () => void;
}

export function ChatHistoryPanel({ tabId, projectName, sessionId, onSelectSession, historyFilter, onClose }: ChatHistoryPanelProps) {
  const project = useProjectRef(projectName);
  const id = project ? projectCacheId(project) : null;
  const storeSessions = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);
  const storeHasMoreDefault = useSessionListStore((s) => (id ? s.byProject[id]?.hasMore : undefined) ?? false);
  const storeSyncing = useSessionListStore((s) => (id ? s.byProject[id]?.isSyncing : undefined) ?? false);
  const tagsState = useSessionListStore((s) => (id ? s.byProject[id]?.tags : undefined) ?? null);
  // The base page (unfiltered, un-paginated) is fetched once for every open
  // chat tab of this project and shared through the store; only the panel's
  // own search page and "load more" rows are fetched here directly.
  useEffect(() => { if (project) void useSessionListStore.getState().ensure(project); }, [project]);
  const [pagedExtra, setPagedExtra] = useState<SessionInfo[]>([]);
  const [pageHasMore, setPageHasMore] = useState<boolean | null>(null);
  const [searchFirstPage, setSearchFirstPage] = useState<SessionInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const notifications = useNotificationStore((s) => s.notifications);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [showTagSettings, setShowTagSettings] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const PAGE_SIZE = 50;

  const basePage = debouncedSearch ? (searchFirstPage ?? []) : storeSessions;
  const sessions = sortSessions([...basePage, ...pagedExtra]);
  const hasMore = pageHasMore ?? (debouncedSearch ? false : storeHasMoreDefault);
  const effectiveLoading = loading || (!debouncedSearch && storeSyncing);
  const projectTags = tagsState?.tags ?? [];
  const tagCounts = tagsState?.counts ?? {};

  const load = useCallback(async (query?: string) => {
    if (!projectName) return;
    setPagedExtra([]);
    setPageHasMore(null);
    if (!query) {
      setSearchFirstPage(null);
      if (project) await useSessionListStore.getState().sync(project);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: "0", q: query });
      const data = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`);
      setSearchFirstPage(data.sessions);
      setPageHasMore(data.hasMore);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectName, project]);

  const loadMore = useCallback(async () => {
    if (!projectName || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      // Offset by count of non-pinned sessions (pinned are injected separately by backend)
      const unpinnedCount = sessions.filter((s) => !s.pinned).length;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(unpinnedCount) });
      if (debouncedSearch) params.set("q", debouncedSearch);
      const data = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`);
      setPagedExtra((prev) => {
        const existingIds = new Set([...basePage, ...prev].map((s) => s.id));
        return [...prev, ...data.sessions.filter((s) => !existingIds.has(s.id))];
      });
      setPageHasMore(data.hasMore);
    } catch {
      // silent
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, loadingMore, hasMore, sessions, debouncedSearch, basePage]);

  // Search re-fetches on its own request; clearing it falls back to the
  // store's shared first page (already kept fresh by `ensure` above).
  const searchedRef = useRef(false);
  useEffect(() => {
    // Opening the panel asks nothing: the store's first page is already kept fresh.
    if (!searchedRef.current && !debouncedSearch) return;
    searchedRef.current = true;
    load(debouncedSearch || undefined);
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTags = useCallback(async () => {
    if (project) await useSessionListStore.getState().refreshTags(project);
  }, [project]);

  function openSession(session: SessionInfo) {
    if (tabId) window.dispatchEvent(new CustomEvent("ppm:onboarding-evidence", {
      detail: { type: "history-opened", projectName, tabId, sessionId: session.id,
        visible: !document.hidden && Object.values(usePanelStore.getState().panels).some((panel) => panel.activeTabId === tabId) },
    }));
    const staysHere = historyFilter ? session.designSlug === historyFilter : !session.designSlug;
    if (onSelectSession && staysHere) {
      onSelectSession(session);
    } else {
      openSessionInItsTab(session, projectName);
    }
    onClose();
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
    const title = editingTitle.trim();
    const sid = editingId;
    const ref = project ?? projectRefForName(projectName);
    // Optimistic: every list shows the new title now; a refused save re-syncs the store
    // (`commitOptimistic`) and reloads this bar's own pages.
    useSessionListStore.getState().renameSession(ref, sid, title);
    setPagedExtra((prev) => renameSession(prev, sid, title));
    setSearchFirstPage((prev) => prev ? renameSession(prev, sid, title) : prev);
    setEditingId(null);
    const ok = await commitOptimistic(ref, () => api.patch(`${projectUrl(projectName)}/chat/sessions/${sid}`, { title }));
    if (!ok) void load(debouncedSearch || undefined);
  }, [editingId, editingTitle, projectName, project, load, debouncedSearch]);

  const cancelEditing = useCallback(() => setEditingId(null), []);

  const togglePin = useCallback(async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    if (!projectName) return;
    const url = `${projectUrl(projectName)}/chat/sessions/${session.id}/pin`;
    const nextPinned = !session.pinned;
    const ref = project ?? projectRefForName(projectName);
    useSessionListStore.getState().setPinned(ref, session.id, nextPinned);
    setPagedExtra((prev) => setPinned(prev, session.id, nextPinned));
    setSearchFirstPage((prev) => prev ? setPinned(prev, session.id, nextPinned) : prev);
    const ok = await commitOptimistic(ref, () => (nextPinned ? api.put(url) : api.del(url)));
    if (!ok) void load(debouncedSearch || undefined);
  }, [projectName, project, load, debouncedSearch]);

  const deleteSession = useCallback(async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    if (!projectName) return;
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
    const ref = project ?? projectRefForName(projectName);
    useSessionListStore.getState().removeSession(ref, session.id);
    setPagedExtra((prev) => removeSession(prev, session.id));
    setSearchFirstPage((prev) => prev ? removeSession(prev, session.id) : prev);
    const ok = await commitOptimistic(ref, () =>
      api.del(`${projectUrl(projectName)}/chat/sessions/${session.id}?providerId=${session.providerId}`));
    if (!ok) void load(debouncedSearch || undefined);
  }, [projectName, project, load, debouncedSearch]);

  /** Applies a tag change to every list at once — called before the request is sent
   * (see `SessionContextMenu`), and again with the old tag if it is refused. */
  const handleTagChanged = useCallback((sid: string, tag: { id: number; name: string; color: string } | null) => {
    const ref = project ?? (projectName ? projectRefForName(projectName) : null);
    if (ref) useSessionListStore.getState().setSessionTag(ref, sid, tag);
    setPagedExtra((prev) => setSessionTag(prev, sid, tag));
    setSearchFirstPage((prev) => prev ? setSessionTag(prev, sid, tag) : prev);
    loadTags(); // Refetch counts from API for accuracy
  }, [loadTags, project, projectName]);

  const bulkDelete = useCallback(async () => {
    if (!projectName) return;
    const days = window.prompt("Delete sessions older than how many days? (pinned sessions are kept)", "30");
    if (!days) return;
    const num = parseInt(days, 10);
    if (!num || num < 1) return;
    if (!window.confirm(`Delete all unpinned sessions older than ${num} days? This cannot be undone.`)) return;
    setLoading(true);
    const ref = project ?? projectRefForName(projectName);
    useSessionListStore.getState().removeOlderThan(ref, num);
    await commitOptimistic(ref, () => api.del(`${projectUrl(projectName)}/chat/sessions?olderThanDays=${num}`));
    // Reloaded either way: the local rule only approximates the server's, so even a
    // successful delete is corrected by what the server says it kept.
    await load(debouncedSearch || undefined);
    setLoading(false);
  }, [projectName, project, load, debouncedSearch]);

  // Keyboard shortcuts: 1-9 to assign tags to current session
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= projectTags.length && sessionId) {
        const tag = projectTags[num - 1];
        if (tag) {
          handleTagChanged(sessionId, { id: tag.id, name: tag.name, color: tag.color });
          void commitOptimistic(projectRefForName(projectName), () =>
            api.patch(`${projectUrl(projectName)}/chat/sessions/${sessionId}/tag`, { tagId: tag.id }));
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [projectTags, sessionId, projectName, handleTagChanged]);

  // Filter by tag client-side (search is now server-side via ?q=)
  // Inside a design tab the picker is that design's history, nothing else.
  const scopedSessions = historyFilter ? sessions.filter((s) => s.designSlug === historyFilter) : sessions;
  const filteredSessions = selectedTagId !== null
    ? scopedSessions.filter((s) => s.tag?.id === selectedTagId)
    : scopedSessions;

  return (
        <div className="flex min-h-0 flex-1 flex-col" data-chat-history-panel="">
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
              className="p-0.5 rounded text-text-subtle hover:text-error transition-colors"
              title="Delete old sessions..."
            >
              <CalendarX2 className="size-3" />
            </button>
            <button
              onClick={() => load(debouncedSearch || undefined)}
              disabled={effectiveLoading}
              className="p-0.5 rounded text-text-subtle hover:text-text-secondary transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`size-3 ${effectiveLoading ? "animate-spin" : ""}`} />
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
              >All ({scopedSessions.length})</button>
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

          <div className="max-h-[260px] min-h-0 overflow-y-auto overscroll-contain max-md:max-h-none max-md:flex-1">
            {effectiveLoading && scopedSessions.length === 0 ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="size-3.5 animate-spin text-text-subtle" />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex items-center justify-center py-3 text-[11px] text-text-subtle">
                {searchQuery ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              <>
                {filteredSessions.map((session) => {
                  const notif = notifications.get(session.id);
                  const isUnread = !!notif;
                  return (
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
                    data-onboarding="chat-history-session"
                    className={cn(
                      "flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-surface-elevated transition-colors group",
                      isUnread && "font-medium text-foreground",
                      isUnread && notificationTint(notif.type),
                      !isUnread && "text-text-secondary",
                    )}
                  >
                    <ProviderBadge providerId={session.providerId} />
                    {session.tag && (
                      <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
                    )}
                    <SpawnedSessionBadge session={session} projectName={projectName} />
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
                          // Escape cancels the rename, not the History popover around it.
                          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancelEditing(); } }}
                          className="flex-1 min-w-0 bg-surface-elevated text-[11px] text-text-primary px-1 py-0.5 rounded border border-border outline-none focus:border-primary"
                          autoFocus
                        />
                        <button type="submit" className="p-0.5 text-success hover:text-success/80" onClick={(e) => e.stopPropagation()}>
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
                          <span className="min-w-0 truncate">
                            {session.title?.startsWith("[PPM]")
                              ? session.title.slice(7)
                              : session.title || "Untitled"}
                          </span>
                          <ManagerChatBadge session={session} />
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
                          className="p-0.5 rounded text-text-subtle hover:text-error hover:bg-error/20 can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity"
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
                  );
                })}
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
  );
}
