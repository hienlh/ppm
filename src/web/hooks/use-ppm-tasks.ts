/**
 * PPM Tasks for components: a list, one task, its history, its links' live state, and the writes.
 * Each write goes through the store, so its answer shows in every open list at once and a stale
 * write turns into a re-read plus "Changed elsewhere — refreshed" (the write then answers null).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ppmTasksClient, type TaskCreateBody, type TaskListQuery } from "@/lib/ppm-tasks/ppm-tasks-client";
import { listKey } from "@/lib/ppm-tasks/ppm-tasks-list-logic";
import { ensurePpmTasksEvents, ppmTasksStore, usePpmTasksStore } from "@/stores/ppm-tasks-store";
import type { ClosedAs, TaskPatch } from "../../shared/ppm-tasks";
import type {
  TaskDto, TaskHistoryFilter, TaskHistoryItem, TaskLinkStatesResponse, TaskProjectSummary, TasksGlobalEvent,
} from "../../shared/ppm-tasks-api";

const NO_TASKS: TaskDto[] = [];
const NO_PROJECTS: TaskProjectSummary[] = [];

/** A task list, kept current; null `query` shows nothing. */
export function usePpmTaskList(query: TaskListQuery | null) {
  const key = query ? listKey(query) : null;
  // The query object may be a new literal every render; the key is what identifies the list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => query, [key]);
  useEffect(() => {
    if (!stable) return;
    ensurePpmTasksEvents();
    return ppmTasksStore.getState().watchList(stable);
  }, [stable]);
  const entry = usePpmTasksStore((s) => (key ? s.lists[key] : undefined));
  const refresh = useCallback(() => { if (stable) void ppmTasksStore.getState().fetchList(stable); }, [stable]);
  return {
    tasks: entry?.data?.tasks ?? NO_TASKS,
    projects: entry?.data?.projects ?? NO_PROJECTS,
    loading: !entry?.data && (entry?.loading ?? !!stable),
    error: entry?.error ?? null,
    refresh,
  };
}

/** One task with its children and link states; null `id` shows nothing. */
export function usePpmTask(id: string | null) {
  useEffect(() => {
    if (!id) return;
    ensurePpmTasksEvents();
    return ppmTasksStore.getState().watchDetail(id);
  }, [id]);
  const entry = usePpmTasksStore((s) => (id ? s.details[id] : undefined));
  const refresh = useCallback(() => { if (id) void ppmTasksStore.getState().fetchDetail(id); }, [id]);
  return { detail: entry?.data ?? null, loading: !entry?.data && (entry?.loading ?? !!id), error: entry?.error ?? null, refresh };
}

/** Re-runs `load` on every `tasks:*` event of type `type` that `matches`. */
function useTaskEvent(type: TasksGlobalEvent["type"], matches: (detail: TasksGlobalEvent) => boolean, load: () => void): void {
  useEffect(() => {
    const on = (event: Event) => {
      const detail = (event as CustomEvent<TasksGlobalEvent>).detail;
      if (detail && matches(detail)) load();
    };
    window.addEventListener(type, on);
    return () => window.removeEventListener(type, on);
  }, [type, matches, load]);
}

/** A task's history, newest first, re-read when the task changes. */
export function usePpmTaskHistory(id: string | null, filter: TaskHistoryFilter = "all") {
  const [items, setItems] = useState<TaskHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(0);
  const load = useCallback(() => {
    if (!id) return;
    const n = ++asked.current;
    setLoading(true);
    ppmTasksClient.history(id, filter)
      // Only the latest read lands: a slow answer for the previous task or filter is dropped.
      .then((h) => { if (n === asked.current) { setItems(h); setError(null); } })
      .catch((e: Error) => { if (n === asked.current) setError(e.message); })
      .finally(() => { if (n === asked.current) setLoading(false); });
  }, [id, filter]);
  useEffect(() => { setItems([]); load(); }, [load]);
  const matches = useCallback((d: TasksGlobalEvent) => d.type === "tasks:changed" && !!id && d.taskIds.includes(id), [id]);
  useTaskEvent("tasks:changed", matches, load);
  return { items, loading, error, refresh: load };
}

/** Live link states and working sessions of these tasks, re-read when PPM says they changed. */
export function usePpmTaskLinkStates(taskIds: readonly string[], project: string | null) {
  const idsKey = [...taskIds].sort().join(",");
  const [data, setData] = useState<TaskLinkStatesResponse["tasks"]>({});
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    if (!idsKey) { setData({}); return; }
    ppmTasksClient.linkStates(idsKey.split(","))
      .then((r) => { if (n === asked.current) setData(r.tasks); })
      .catch(() => { /* states stay as they were */ });
  }, [idsKey]);
  useEffect(load, [load]);
  const matches = useCallback((d: TasksGlobalEvent) => !project || project === "all" || d.project === project, [project]);
  useTaskEvent("tasks:link_states", matches, load);
  return data;
}

/** The writes, each folded into the store; `null` back means it was stale and has been re-read. */
export function usePpmTaskActions() {
  return useMemo(() => {
    const w = ppmTasksStore.getState().write;
    return {
      create: (body: TaskCreateBody) => w(null, () => ppmTasksClient.create(body)),
      update: (t: Pick<TaskDto, "id" | "revision">, patch: TaskPatch & { decision?: { question?: string | null; options: string[] } }) =>
        w(t.id, () => ppmTasksClient.patch(t.id, t.revision, patch)),
      close: (t: Pick<TaskDto, "id" | "revision">, opts: { closedAs?: ClosedAs; statusId?: string } = {}) =>
        w(t.id, () => ppmTasksClient.close(t.id, t.revision, opts)),
      reopen: (t: Pick<TaskDto, "id" | "revision">, statusId?: string) => w(t.id, () => ppmTasksClient.reopen(t.id, t.revision, statusId)),
      reorder: (t: Pick<TaskDto, "id" | "revision">, to: { beforeId?: string; afterId?: string }) =>
        w(t.id, () => ppmTasksClient.reorder(t.id, t.revision, to)),
      /** Throws `NoSessionError` when no chat can take the choice: offer Start chat. */
      decide: (t: Pick<TaskDto, "id" | "revision">, optionId: string) => w(t.id, () => ppmTasksClient.decide(t.id, t.revision, optionId)),
      startChat: (t: Pick<TaskDto, "id" | "revision">) => w(t.id, () => ppmTasksClient.startChat(t.id, t.revision)),
      addLink: (t: Pick<TaskDto, "id" | "revision">, link: { kind: string; ref: string; label?: string | null }) =>
        w(t.id, () => ppmTasksClient.addLink(t.id, t.revision, link)),
      removeLink: (t: Pick<TaskDto, "id" | "revision">, link: { kind: string; ref: string }) =>
        w(t.id, () => ppmTasksClient.removeLink(t.id, t.revision, link)),
      undo: (taskId: string, historyId: number) => w(taskId, () => ppmTasksClient.undo(historyId)),
    };
  }, []);
}
