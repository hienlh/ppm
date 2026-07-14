import { useState, useEffect, useCallback, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { SessionInfo, SessionListResponse, ProjectTag } from "../../types/chat";

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
 * and the sidebar History tab render identical behavior. Server-side title
 * search via `?q=`; tag filter is client-side.
 */
export function useSessionHistory({
  projectName,
  sessionId,
  onSelectSession,
  enableKeyboardShortcuts = false,
}: UseSessionHistoryOptions) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
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

  // Initial load + tags on mount.
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (projectName) loadTags(); }, [projectName, loadTags]);

  // Re-fetch when debounced search changes (server-side title search).
  useEffect(() => { load(debouncedSearch || undefined); }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  function openSession(session: SessionInfo) {
    if (onSelectSession) {
      onSelectSession(session);
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

  // Keyboard shortcuts: 1–9 assign tags to the current session (bar only).
  useEffect(() => {
    if (!enableKeyboardShortcuts) return;
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
  }, [enableKeyboardShortcuts, projectTags, sessionId, projectName, handleTagChanged]);

  // Client-side tag filter (title search is server-side via ?q=).
  const filteredSessions = selectedTagId !== null
    ? sessions.filter((s) => s.tag?.id === selectedTagId)
    : sessions;

  return {
    sessions, filteredSessions, loading, hasMore, loadingMore,
    searchQuery, setSearchQuery,
    editingId, editingTitle, setEditingTitle, editInputRef,
    projectTags, selectedTagId, setSelectedTagId, tagCounts,
    showTagSettings, setShowTagSettings,
    load, loadMore, loadTags,
    openSession, startEditing, saveTitle, cancelEditing,
    togglePin, deleteSession, handleTagChanged, bulkDelete,
  };
}
