/**
 * Each open chat's bookmarked turns (`/chat/sessions/:id/bookmarks`), loaded once per chat and
 * changed optimistically: a failed save puts the list back and says so.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { api, projectUrl } from "@/lib/api-client";
import type { SessionBookmark } from "../../shared/session-bookmarks";

const keyOf = (projectName: string, sessionId: string) => projectName + "\n" + sessionId;
const urlOf = (projectName: string, sessionId: string, turnId?: string) =>
  projectUrl(projectName) + "/chat/sessions/" + encodeURIComponent(sessionId) + "/bookmarks" + (turnId ? "/" + encodeURIComponent(turnId) : "");

interface SessionBookmarksState {
  lists: Record<string, SessionBookmark[]>;
  load: (projectName: string, sessionId: string) => Promise<void>;
  /** Bookmark the turn, or take the bookmark off when it has one. */
  toggle: (projectName: string, sessionId: string, b: { turnId: string; turnN?: number; label: string }) => Promise<void>;
  remove: (projectName: string, sessionId: string, turnId: string) => Promise<void>;
}

const loading = new Set<string>();

export const useSessionBookmarks = create<SessionBookmarksState>((set, get) => {
  const save = async (key: string, next: SessionBookmark[], call: () => Promise<SessionBookmark[]>) => {
    const before = get().lists[key];
    set((s) => ({ lists: { ...s.lists, [key]: next } }));
    try {
      const saved = await call();
      set((s) => ({ lists: { ...s.lists, [key]: saved } }));
    } catch {
      set((s) => ({ lists: { ...s.lists, [key]: before ?? [] } }));
      toast.error("Could not save the bookmark");
    }
  };
  return {
    lists: {},
    load: async (projectName, sessionId) => {
      const key = keyOf(projectName, sessionId);
      if (get().lists[key] || loading.has(key)) return;
      loading.add(key);
      try {
        const list = await api.get<SessionBookmark[]>(urlOf(projectName, sessionId));
        set((s) => ({ lists: { ...s.lists, [key]: s.lists[key] ?? list } }));
      } catch {
        // No list yet: the next open tries again.
      } finally {
        loading.delete(key);
      }
    },
    toggle: async (projectName, sessionId, b) => {
      const key = keyOf(projectName, sessionId);
      const list = get().lists[key] ?? [];
      if (list.some((x) => x.turnId === b.turnId)) return get().remove(projectName, sessionId, b.turnId);
      const next = [...list, { ...b, createdAt: new Date().toISOString() }]
        .sort((x, y) => (x.turnN ?? Infinity) - (y.turnN ?? Infinity));
      await save(key, next, () => api.put<SessionBookmark[]>(urlOf(projectName, sessionId, b.turnId), { turnN: b.turnN, label: b.label }));
    },
    remove: async (projectName, sessionId, turnId) => {
      const key = keyOf(projectName, sessionId);
      const next = (get().lists[key] ?? []).filter((x) => x.turnId !== turnId);
      await save(key, next, () => api.delete<SessionBookmark[]>(urlOf(projectName, sessionId, turnId)));
    },
  };
});

/** The chat's bookmarks, loading them the first time they are asked for. */
export function useChatBookmarks(projectName: string | undefined, sessionId: string | null | undefined): SessionBookmark[] | undefined {
  const key = projectName && sessionId ? keyOf(projectName, sessionId) : "";
  const list = useSessionBookmarks((s) => (key ? s.lists[key] : undefined));
  if (key && !list) void useSessionBookmarks.getState().load(projectName!, sessionId!);
  return list;
}
