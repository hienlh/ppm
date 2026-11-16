/**
 * The PPM Tasks store, built from what it needs (the client, a toast) so tests drive it with fakes.
 * Lists are kept per query; a write's answer is folded into every cached list and detail at once,
 * and a `/ws/global` change re-reads only the lists someone is looking at (the rest are dropped and
 * fetched fresh on the next look). A write that hit a newer revision is never retried: the store
 * re-reads the task and its lists and says "Changed elsewhere — refreshed".
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { TaskDetailResponse, TaskDto, TaskListResponse, TaskWriteResponse } from "../../../shared/ppm-tasks-api";
import { StaleTaskError, type TaskListQuery, type ppmTasksClient } from "./ppm-tasks-client";
import { foldTask, listCovers, listKey } from "./ppm-tasks-list-logic";

export interface TaskListEntry {
  query: TaskListQuery;
  data: TaskListResponse | null;
  loading: boolean;
  error: string | null;
  /** Mounted views showing this list; a list nobody shows is dropped on a change, not re-read. */
  watchers: number;
}

export interface TaskDetailEntry {
  data: TaskDetailResponse | null;
  loading: boolean;
  error: string | null;
  watchers: number;
}

export interface PpmTasksState {
  lists: Record<string, TaskListEntry>;
  details: Record<string, TaskDetailEntry>;
  /** The task open in the detail view, if any. */
  selectedId: string | null;
}

export interface PpmTasksActions {
  watchList(query: TaskListQuery): () => void;
  watchDetail(id: string): () => void;
  fetchList(query: TaskListQuery): Promise<void>;
  fetchDetail(id: string): Promise<void>;
  select(id: string | null): void;
  /** Folds a task the server just answered with into every cached list and detail. */
  applyTask(task: TaskDto): void;
  /**
   * Runs a write. Its answer is applied; a stale write re-reads and toasts instead, answering null.
   * Every other failure is thrown to the caller.
   */
  write<T extends TaskWriteResponse>(taskId: string | null, run: () => Promise<T>): Promise<T | null>;
  onTasksChanged(project: string, taskIds: readonly string[]): void;
  onProjectChanged(project: string): void;
  /** After a lost connection: re-read what is shown, forget what is not (it may have changed). */
  resync(): void;
}

export type PpmTasksStore = StoreApi<PpmTasksState & PpmTasksActions>;

export interface PpmTasksStoreDeps {
  client: Pick<typeof ppmTasksClient, "list" | "get">;
  toast(message: string): void;
}

export const STALE_TOAST = "Changed elsewhere — refreshed";

const message = (e: unknown): string => (e as Error)?.message ?? String(e);

export function createPpmTasksStore(deps: PpmTasksStoreDeps): PpmTasksStore {
  return createStore<PpmTasksState & PpmTasksActions>()((set, get) => {
    const patchList = (key: string, patch: Partial<TaskListEntry>) =>
      set((s) => (s.lists[key] ? { lists: { ...s.lists, [key]: { ...s.lists[key]!, ...patch } } } : s));
    const patchDetail = (id: string, patch: Partial<TaskDetailEntry>) =>
      set((s) => (s.details[id] ? { details: { ...s.details, [id]: { ...s.details[id]!, ...patch } } } : s));

    /** Each read is numbered per list or task; a write's answer also counts, so a read sent before it loses. */
    const asks = new Map<string, number>();
    const nextAsk = (key: string): number => {
      const n = (asks.get(key) ?? 0) + 1;
      asks.set(key, n);
      return n;
    };
    const isLatest = (key: string, n: number): boolean => asks.get(key) === n;

    /** Re-reads the lists covering `project` that someone shows; drops the others. */
    function refreshLists(project: string): void {
      const { lists } = get();
      const next = { ...lists };
      const refetch: TaskListQuery[] = [];
      for (const [key, entry] of Object.entries(lists)) {
        if (!listCovers(entry.query, project)) continue;
        if (entry.watchers > 0) refetch.push(entry.query);
        else delete next[key];
      }
      set({ lists: next });
      for (const query of refetch) void get().fetchList(query);
    }

    function refreshDetail(id: string): void {
      const entry = get().details[id];
      if (!entry) return;
      if (entry.watchers > 0) void get().fetchDetail(id);
      else set((s) => {
        const { [id]: _dropped, ...rest } = s.details;
        return { details: rest };
      });
    }

    return {
      lists: {},
      details: {},
      selectedId: null,

      watchList(query) {
        const key = listKey(query);
        const had = get().lists[key];
        set((s) => ({ lists: { ...s.lists, [key]: had ? { ...had, watchers: had.watchers + 1 } : { query, data: null, loading: false, error: null, watchers: 1 } } }));
        if (!had?.data && !had?.loading) void get().fetchList(query);
        return () => patchList(key, { watchers: Math.max(0, (get().lists[key]?.watchers ?? 1) - 1) });
      },

      watchDetail(id) {
        const had = get().details[id];
        set((s) => ({ details: { ...s.details, [id]: had ? { ...had, watchers: had.watchers + 1 } : { data: null, loading: false, error: null, watchers: 1 } } }));
        if (!had?.data && !had?.loading) void get().fetchDetail(id);
        return () => patchDetail(id, { watchers: Math.max(0, (get().details[id]?.watchers ?? 1) - 1) });
      },

      async fetchList(query) {
        const key = listKey(query);
        if (!get().lists[key]) set((s) => ({ lists: { ...s.lists, [key]: { query, data: null, loading: false, error: null, watchers: 0 } } }));
        patchList(key, { loading: true });
        const asked = nextAsk(`list:${key}`);
        try {
          const data = await deps.client.list(query);
          // A slower, older answer must not overwrite a newer one (or a write folded in since).
          if (isLatest(`list:${key}`, asked)) patchList(key, { data, loading: false, error: null });
        } catch (e) {
          if (isLatest(`list:${key}`, asked)) patchList(key, { loading: false, error: message(e) });
        }
      },

      async fetchDetail(id) {
        if (!get().details[id]) set((s) => ({ details: { ...s.details, [id]: { data: null, loading: false, error: null, watchers: 0 } } }));
        patchDetail(id, { loading: true });
        const asked = nextAsk(`task:${id}`);
        try {
          const data = await deps.client.get(id);
          if (isLatest(`task:${id}`, asked)) patchDetail(id, { data, loading: false, error: null });
        } catch (e) {
          if (isLatest(`task:${id}`, asked)) patchDetail(id, { loading: false, error: message(e) });
        }
      },

      resync() {
        const { lists, details } = get();
        const keptLists = Object.fromEntries(Object.entries(lists).filter(([, e]) => e.watchers > 0));
        const keptDetails = Object.fromEntries(Object.entries(details).filter(([, e]) => e.watchers > 0));
        set({ lists: keptLists, details: keptDetails });
        for (const entry of Object.values(keptLists)) void get().fetchList(entry.query);
        for (const id of Object.keys(keptDetails)) void get().fetchDetail(id);
      },

      select(id) {
        set({ selectedId: id });
      },

      applyTask(task) {
        // Reads already on their way started before this write: their answers would undo it.
        // Only where the write is folded in: a list or task still waiting for its first answer keeps it.
        if (get().details[task.id]?.data) nextAsk(`task:${task.id}`);
        for (const [key, entry] of Object.entries(get().lists)) if (entry.data && listCovers(entry.query, task.project)) nextAsk(`list:${key}`);
        set((s) => {
          const lists: Record<string, TaskListEntry> = {};
          for (const [key, entry] of Object.entries(s.lists)) {
            // The reads in flight were just outrun, so nothing will clear their loading flag.
            lists[key] = entry.data && listCovers(entry.query, task.project)
              ? { ...entry, loading: false, data: { ...entry.data, tasks: foldTask(entry.data.tasks, task, entry.query) } }
              : entry;
          }
          const details = { ...s.details };
          const own = details[task.id];
          if (own?.data) details[task.id] = { ...own, loading: false, data: { ...own.data, task } };
          // A child shown under its parent changes there too.
          for (const [id, entry] of Object.entries(details)) {
            if (id === task.id || !entry.data?.children.some((c) => c.id === task.id)) continue;
            details[id] = { ...entry, data: { ...entry.data, children: entry.data.children.map((c) => (c.id === task.id ? task : c)) } };
          }
          return { lists, details };
        });
      },

      async write(taskId, run) {
        try {
          const answer = await run();
          get().applyTask(answer.task);
          return answer;
        } catch (e) {
          if (!(e instanceof StaleTaskError)) throw e;
          const project = taskId ? get().details[taskId]?.data?.task.project ?? findProject(get().lists, taskId) : null;
          if (taskId) refreshDetail(taskId);
          if (project) refreshLists(project);
          else for (const entry of Object.values(get().lists)) if (entry.watchers > 0) void get().fetchList(entry.query);
          deps.toast(STALE_TOAST);
          return null;
        }
      },

      onTasksChanged(project, taskIds) {
        refreshLists(project);
        for (const id of taskIds) refreshDetail(id);
        // A parent shows its children: re-read the details holding any of them.
        for (const [id, entry] of Object.entries(get().details)) {
          if (!taskIds.includes(id) && entry.data?.children.some((c) => taskIds.includes(c.id))) refreshDetail(id);
        }
      },

      onProjectChanged(project) {
        refreshLists(project);
        for (const [id, entry] of Object.entries(get().details)) if (entry.data?.task.project === project) refreshDetail(id);
      },
    };
  });
}

function findProject(lists: Record<string, TaskListEntry>, taskId: string): string | null {
  for (const entry of Object.values(lists)) {
    const t = entry.data?.tasks.find((x) => x.id === taskId);
    if (t) return t.project;
  }
  return null;
}
