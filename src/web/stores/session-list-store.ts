/**
 * Shared per-project session list + tags. Every recent-session surface
 * (sidebar, welcome screen, tab bar, mobile nav, history bar) reads from
 * here instead of fetching its own copy. Hydrated from IndexedDB (the
 * hydrator is registered at the bottom of this file), synced with one
 * deduplicated `/chat/sessions` + `/tags` request per project, and patched
 * optimistically by every local rename/pin/tag/delete: the store changes
 * before the request is sent, and a failed request re-syncs the project,
 * which puts back whatever the server still has (`optimisticMutation`).
 * Creates and forks are upserted once the server has answered, because only
 * then is there an id to show. List math (sort, dedupe, id replace, the
 * bulk-delete cutoff) lives in `session-list-merge.ts` so it stays importable
 * under `bun:test`.
 */
import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import { idbGet, idbSet } from "@/lib/browser-cache/idb-keyval-cache";
import { projectCacheId, sessions as sessionsKey, tags as tagsKey, type ProjectCacheRef } from "@/lib/browser-cache/cache-keys";
import { hydrateProjectCache, registerProjectHydrator } from "@/lib/browser-cache/project-cache-hydration";
import { registerCacheReset } from "@/lib/browser-cache/wipe-browser-caches";
import {
  sortSessions,
  upsertSession as mergeUpsert,
  removeSession as mergeRemove,
  renameSession as mergeRename,
  replaceSessionId as mergeReplaceId,
  setPinned as mergeSetPinned,
  setSessionTag as mergeSetTag,
  clearDeletedTag as mergeClearTag,
  removeOlderThan as mergeRemoveOlderThan,
} from "@/lib/session-list-merge";
import type { SessionInfo, SessionListResponse, ProjectTag } from "../../types/chat";

const PAGE_SIZE = 50;
export const STALE_MS = 15_000;
const TAG_SEED_FRESH_MS = 30_000;

export interface SessionTagsState {
  tags: ProjectTag[];
  counts: Record<number, number>;
  defaultTagId: number | null;
}

export interface ProjectSessionState {
  /** The ref this state was last touched with — kept so background triggers
   * (visibility, ws reconnect) can re-sync without a component in scope. */
  project: ProjectCacheRef | null;
  sessions: SessionInfo[];
  hasMore: boolean;
  tags: SessionTagsState | null;
  isSyncing: boolean;
  lastSyncError: string | null;
  lastSyncedAt: number | null;
  hydrated: boolean;
  tagsSeededAt: number | null;
}

/** A stable empty array for every "no project entry yet" selector fallback.
 * A fresh `[]` literal there is a new reference on every call, and zustand's
 * `useSyncExternalStore` subscription treats that as "the snapshot changed"
 * on every render — an infinite render loop, not just a wasted one. */
export const EMPTY_SESSIONS: SessionInfo[] = [];

export function emptyProjectSessionState(): ProjectSessionState {
  return {
    project: null, sessions: EMPTY_SESSIONS, hasMore: false, tags: null,
    isSyncing: false, lastSyncError: null, lastSyncedAt: null,
    hydrated: false, tagsSeededAt: null,
  };
}

/** In-flight sync promises, per project id — kept outside the store state so
 * the dedupe check itself never triggers a re-render. */
const inFlight = new Map<string, Promise<void>>();

type Tag = { id: number; name: string; color: string };

interface SessionListStore {
  byProject: Record<string, ProjectSessionState>;
  ensure: (project: ProjectCacheRef) => Promise<void>;
  sync: (project: ProjectCacheRef) => Promise<void>;
  upsertSession: (project: ProjectCacheRef, session: SessionInfo) => void;
  removeSession: (project: ProjectCacheRef, id: string) => void;
  renameSession: (project: ProjectCacheRef, id: string, title: string) => void;
  replaceSessionId: (project: ProjectCacheRef, oldId: string, newId: string) => void;
  setPinned: (project: ProjectCacheRef, id: string, pinned: boolean) => void;
  setSessionTag: (project: ProjectCacheRef, id: string, tag: Tag | null) => void;
  removeOlderThan: (project: ProjectCacheRef, days: number) => void;
  seedTags: (project: ProjectCacheRef, tags: SessionTagsState) => void;
  refreshTags: (project: ProjectCacheRef) => Promise<void>;
  onTagDeleted: (project: ProjectCacheRef, tagId: number) => void;
}

async function fetchTags(project: ProjectCacheRef): Promise<SessionTagsState> {
  return api.get<SessionTagsState>(`${projectUrl(project.name)}/tags`);
}

export const useSessionListStore = create<SessionListStore>((set, get) => {
  function patch(project: ProjectCacheRef, updater: (s: ProjectSessionState) => ProjectSessionState): ProjectSessionState {
    const id = projectCacheId(project);
    const current = get().byProject[id] ?? emptyProjectSessionState();
    const next = updater({ ...current, project });
    set({ byProject: { ...get().byProject, [id]: next } });
    return next;
  }

  /** Every list mutation writes its result straight through to IndexedDB —
   * a reload must see the same optimistic state this tab already committed to. */
  function patchList(project: ProjectCacheRef, fn: (sessions: SessionInfo[]) => SessionInfo[]): void {
    const id = projectCacheId(project);
    const next = patch(project, (s) => ({ ...s, sessions: fn(s.sessions) }));
    void idbSet(sessionsKey(id), { sessions: next.sessions, hasMore: next.hasMore });
  }

  function patchTags(project: ProjectCacheRef, tags: SessionTagsState): void {
    const id = projectCacheId(project);
    patch(project, (s) => ({ ...s, tags, tagsSeededAt: Date.now() }));
    void idbSet(tagsKey(id), tags);
  }

  return {
    byProject: {},

    ensure: async (project) => {
      const id = projectCacheId(project);
      // Idempotent per project id (`hydrateProjectCache` dedupes) — a component
      // mounting after app boot already warmed this project is a no-op read;
      // one that is first to ask actually hydrates from IndexedDB.
      await hydrateProjectCache(project);
      const state = get().byProject[id];
      const stale = !state || state.lastSyncedAt === null || Date.now() - state.lastSyncedAt > STALE_MS;
      if (stale) await get().sync(project);
    },

    sync: (project) => {
      const id = projectCacheId(project);
      const existing = inFlight.get(id);
      if (existing) return existing;
      const promise = (async () => {
        patch(project, (s) => ({ ...s, isSyncing: true }));
        try {
          const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: "0" });
          const data = await api.get<SessionListResponse>(`${projectUrl(project.name)}/chat/sessions?${params}`);
          const cur = get().byProject[id] ?? emptyProjectSessionState();
          const tagsFresh = cur.tagsSeededAt !== null && Date.now() - cur.tagsSeededAt < TAG_SEED_FRESH_MS;
          let tags = cur.tags;
          let tagsSeededAt = cur.tagsSeededAt;
          if (!tagsFresh) {
            try {
              tags = await fetchTags(project);
              tagsSeededAt = Date.now();
            } catch {
              // Tags are secondary to the session list — keep whatever is cached.
            }
          }
          const sessions = sortSessions(data.sessions);
          patch(project, () => ({
            project, sessions, hasMore: data.hasMore, tags, tagsSeededAt,
            isSyncing: false, lastSyncError: null, lastSyncedAt: Date.now(), hydrated: true,
          }));
          void idbSet(sessionsKey(id), { sessions, hasMore: data.hasMore });
          if (tags) void idbSet(tagsKey(id), tags);
        } catch (err) {
          // Keep whatever rows are already shown — a failed sync must not blank
          // out a working cached list, only flag that it is now stale.
          patch(project, (s) => ({ ...s, isSyncing: false, lastSyncError: err instanceof Error ? err.message : "Sync failed" }));
        } finally {
          inFlight.delete(id);
        }
      })();
      inFlight.set(id, promise);
      return promise;
    },

    upsertSession: (project, session) => patchList(project, (list) => mergeUpsert(list, session)),
    removeSession: (project, id) => patchList(project, (list) => mergeRemove(list, id)),
    renameSession: (project, id, title) => patchList(project, (list) => mergeRename(list, id, title)),
    replaceSessionId: (project, oldId, newId) => patchList(project, (list) => mergeReplaceId(list, oldId, newId)),
    setPinned: (project, id, pinned) => patchList(project, (list) => mergeSetPinned(list, id, pinned)),
    setSessionTag: (project, id, tag) => patchList(project, (list) => mergeSetTag(list, id, tag)),
    removeOlderThan: (project, days) => patchList(project, (list) => mergeRemoveOlderThan(list, days)),
    onTagDeleted: (project, tagId) => patchList(project, (list) => mergeClearTag(list, tagId)),

    seedTags: (project, tags) => patchTags(project, tags),
    refreshTags: async (project) => {
      try {
        patchTags(project, await fetchTags(project));
      } catch {
        // silent — the caller already reflected its own local change
      }
    },
  };
});

/**
 * Sends the request behind a change the caller has already applied to the store.
 *
 * The store is patched first so every list shows the change at once; if the server then
 * refuses it, the project is re-synced, which replaces the optimistic rows with whatever
 * the server still has — the rollback, without each call site keeping its own undo.
 * Resolves whether the request succeeded and never rejects, so a caller that also keeps
 * a local copy (a search page, "load more" rows) knows when to refresh that as well.
 */
export async function commitOptimistic(project: ProjectCacheRef, request: () => Promise<unknown>): Promise<boolean> {
  try {
    await request();
    return true;
  } catch {
    void useSessionListStore.getState().sync(project);
    return false;
  }
}

interface CachedSessions {
  sessions: SessionInfo[];
  hasMore: boolean;
}

// Registered here (not in a separate wiring module) so hydration works for
// anyone who imports the store directly — a unit test, or a consumer that
// only needs the actions — without depending on some other module having
// been loaded first for its side effect.
registerProjectHydrator(async (project) => {
  const id = projectCacheId(project);
  const [cachedSessions, cachedTags] = await Promise.all([
    idbGet<CachedSessions>(sessionsKey(id)),
    idbGet<SessionTagsState>(tagsKey(id)),
  ]);
  useSessionListStore.setState((state) => {
    const current = state.byProject[id] ?? emptyProjectSessionState();
    // A sync (or another hydrator race) may have already landed while this
    // read was in flight — never let a stale cache read stomp on it.
    if (current.hydrated) return state;
    return {
      byProject: {
        ...state.byProject,
        [id]: {
          ...current,
          project,
          sessions: cachedSessions?.sessions ?? current.sessions,
          hasMore: cachedSessions?.hasMore ?? current.hasMore,
          tags: cachedTags ?? current.tags,
          hydrated: true,
        },
      },
    };
  });
});

registerCacheReset(() => {
  useSessionListStore.setState({ byProject: {} });
});

/** Test-only escape hatch: dedupe state does not live in the zustand store,
 * so a suite that wants two "fresh syncs" for the same project id must clear
 * it between them. Production code never calls this. */
export function __clearInFlightForTest(): void {
  inFlight.clear();
}
