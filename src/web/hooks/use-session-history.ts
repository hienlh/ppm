import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { openSessionInItsTab } from "@/lib/design/open-design-tab";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS, commitOptimistic } from "@/stores/session-list-store";
import { projectRefForName, useProjectRef } from "@/stores/session-list-sync-triggers";
import { sortSessions, removeSession, renameSession, setPinned, setSessionTag } from "@/lib/session-list-merge";
import type { SessionInfo, SessionListResponse } from "../../types/chat";

const PAGE_SIZE = 50;

export interface UseSessionHistoryOptions {
  projectName: string;
  /** Current chat session (for keyboard tag shortcuts). */
  sessionId?: string | null;
  /** Override open behavior; when absent, opens a new chat tab. */
  onSelectSession?: (session: SessionInfo) => void;
  /** Enable 1–9 keyboard tag shortcuts (bar variant only, to avoid double-fire). */
  enableKeyboardShortcuts?: boolean;
}

/**
 * Shared chat-history state + mutations, extracted so the in-chat toolbar bar
 * and the sidebar History tab render identical behavior. The default (no
 * search) first page and the project tags come from the shared session-list
 * store — one sync per project, shared with the welcome screen, tab bar and
 * mobile nav. Server-side title search via `?q=` and "load more" beyond the
 * store's first page stay local, on their own requests.
 */
export function useSessionHistory({
  projectName,
  sessionId,
  onSelectSession,
  enableKeyboardShortcuts = false,
}: UseSessionHistoryOptions) {
  const project = useProjectRef(projectName);
  const id = project ? projectCacheId(project) : null;

  useEffect(() => {
    if (project) void useSessionListStore.getState().ensure(project);
  }, [project]);
  const storeSessions = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);
  const storeHasMore = useSessionListStore((s) => (id ? s.byProject[id]?.hasMore : undefined) ?? false);
  const storeSyncing = useSessionListStore((s) => (id ? s.byProject[id]?.isSyncing : undefined) ?? false);
  const tagsState = useSessionListStore((s) => (id ? s.byProject[id]?.tags : undefined) ?? null);

  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [showTagSettings, setShowTagSettings] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Rows beyond the store's first page ("Load more"), and the search result
  // page when a query is active — both fetched directly, never written to
  // the shared store.
  const [pagedExtra, setPagedExtra] = useState<SessionInfo[]>([]);
  const [pageHasMore, setPageHasMore] = useState<boolean | null>(null);
  const [searchFirstPage, setSearchFirstPage] = useState<SessionInfo[] | null>(null);
  const searchRequestRef = useRef(0);

  const basePage = debouncedSearch ? (searchFirstPage ?? []) : storeSessions;
  const sessions = sortSessions([...basePage, ...pagedExtra]);
  const hasMore = pageHasMore ?? (debouncedSearch ? false : storeHasMore);
  // "Loading" covers both an explicit refresh/search fetch and the store's
  // own background sync, so a cold cache still shows a spinner instead of a
  // premature "No sessions yet".
  const effectiveLoading = loading || (!debouncedSearch && storeSyncing);

  // Reset pagination and refetch the search page whenever the debounced
  // query changes; clearing it falls back to the store's own first page.
  useEffect(() => {
    setPagedExtra([]);
    setPageHasMore(null);
    if (!projectName || !debouncedSearch) { setSearchFirstPage(null); return; }
    const request = ++searchRequestRef.current;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: "0", q: debouncedSearch });
        const data = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`);
        if (request !== searchRequestRef.current) return;
        setSearchFirstPage(data.sessions);
        setPageHasMore(data.hasMore);
      } catch {
        // silent
      } finally {
        if (request === searchRequestRef.current) setLoading(false);
      }
    })();
  }, [projectName, debouncedSearch]);

  /** Explicit refresh (the toolbar's refresh button): re-syncs the store for
   * the plain list, or re-runs the search for a filtered one. */
  const load = useCallback(async (query?: string) => {
    setPagedExtra([]);
    setPageHasMore(null);
    if (!projectName) return;
    if (query) {
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
    } else if (project) {
      setSearchFirstPage(null);
      await useSessionListStore.getState().sync(project);
    }
  }, [projectName, project]);

  const loadMore = useCallback(async () => {
    if (!projectName || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
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

  const loadTags = useCallback(async () => {
    if (project) await useSessionListStore.getState().refreshTags(project);
  }, [project]);

  function openSession(session: SessionInfo) {
    if (onSelectSession && !session.designSlug) {
      onSelectSession(session);
    } else {
      // A design session opens in its design tab, where it stays in design mode.
      openSessionInItsTab(session, projectName);
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
    const title = editingTitle.trim();
    const sid = editingId;
    const ref = project ?? projectRefForName(projectName);
    // Optimistic: every list shows the new title now; a refused save re-syncs the store
    // (`commitOptimistic`) and reloads this hook's own pages.
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

  // Keyboard shortcuts: 1–9 assign tags to the current session (bar only).
  const projectTags = useMemo(() => tagsState?.tags ?? [], [tagsState]);
  useEffect(() => {
    if (!enableKeyboardShortcuts) return;
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
  }, [enableKeyboardShortcuts, projectTags, sessionId, projectName, handleTagChanged]);

  // Client-side tag filter (title search is server-side via ?q=).
  const filteredSessions = selectedTagId !== null
    ? sessions.filter((s) => s.tag?.id === selectedTagId)
    : sessions;

  return {
    sessions, filteredSessions, loading: effectiveLoading, hasMore, loadingMore,
    searchQuery, setSearchQuery,
    editingId, editingTitle, setEditingTitle, editInputRef,
    projectTags, selectedTagId, setSelectedTagId, tagCounts: tagsState?.counts ?? {},
    showTagSettings, setShowTagSettings,
    load, loadMore, loadTags,
    openSession, startEditing, saveTitle, cancelEditing,
    togglePin, deleteSession, handleTagChanged, bulkDelete,
  };
}
