/**
 * The browser's door to `/api/tasks`. Failures come back typed: a write that named an old revision
 * is a `StaleTaskError` (the caller re-reads, never retries blindly), a switched-off project a
 * `TasksOffError`, a decision with no chat to go to a `NoSessionError`.
 */
import { api, ApiError } from "@/lib/api-client";
import type { TaskCreateInput, TaskPatch, ClosedAs } from "../../../shared/ppm-tasks";
import {
  taskLinkId,
  type NotifyManagerResponse, type TaskDecideResponse, type TaskDetailResponse, type TaskHistoryFilter,
  type TaskHistoryItem, type TaskLinkStatesResponse, type TaskListResponse, type TaskProjectSettings,
  type TaskProjectSettingsUpdate, type TaskProjectSummary, type TaskStartChatResponse, type TaskWriteResponse,
} from "../../../shared/ppm-tasks-api";

export class PpmTasksApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined) {
    super(message);
    this.name = "PpmTasksApiError";
  }
}

/** The task changed since it was read; `revision` is where it is now. */
export class StaleTaskError extends PpmTasksApiError {
  constructor(message: string, readonly revision: number | null) {
    super(message, 409, "stale");
    this.name = "StaleTaskError";
  }
}

export class TasksOffError extends PpmTasksApiError {
  constructor(message: string) {
    super(message, 404, "tasks_off");
    this.name = "TasksOffError";
  }
}

/** A decision with no working chat and no manager chat: offer Start chat. */
export class NoSessionError extends PpmTasksApiError {
  constructor(message: string) {
    super(message, 409, "no_session");
    this.name = "NoSessionError";
  }
}

/** Turns an `ApiError` from the server into the typed error its `code` names. */
export function typedTaskError(e: unknown): unknown {
  if (!(e instanceof ApiError)) return e;
  const body = e.body as { revision?: unknown } | null;
  switch (e.code) {
    case "stale": return new StaleTaskError(e.message, typeof body?.revision === "number" ? body.revision : null);
    case "tasks_off": return new TasksOffError(e.message);
    case "no_session": return new NoSessionError(e.message);
    default: return new PpmTasksApiError(e.message, e.status, e.code);
  }
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw typedTaskError(e);
  }
}

const enc = encodeURIComponent;
const BASE = "/api/tasks";

export interface TaskListQuery {
  /** A project name, or `all`. */
  project: string;
  groups?: string[];
  types?: string[];
  person?: string;
  tag?: string;
  q?: string;
  closed?: boolean;
}

export function taskListPath(query: TaskListQuery): string {
  const p = new URLSearchParams({ project: query.project });
  if (query.groups?.length) p.set("group", query.groups.join(","));
  if (query.types?.length) p.set("type", query.types.join(","));
  if (query.person) p.set("person", query.person);
  if (query.tag) p.set("tag", query.tag);
  if (query.q?.trim()) p.set("q", query.q.trim());
  if (query.closed) p.set("closed", "1");
  return `${BASE}?${p.toString()}`;
}

export type TaskCreateBody = Omit<TaskCreateInput, "projectKey"> & { project: string };

export const ppmTasksClient = {
  list: (query: TaskListQuery) => call(() => api.get<TaskListResponse>(taskListPath(query))),
  get: (id: string) => call(() => api.get<TaskDetailResponse>(`${BASE}/${enc(id)}`)),
  create: (body: TaskCreateBody) => call(() => api.post<TaskWriteResponse>(BASE, body)),
  patch: (id: string, revision: number, patch: TaskPatch & { decision?: { question?: string | null; options: string[] } }) =>
    call(() => api.patch<TaskWriteResponse>(`${BASE}/${enc(id)}`, { ...patch, revision })),
  close: (id: string, revision: number, opts: { closedAs?: ClosedAs; statusId?: string } = {}) =>
    call(() => api.post<TaskWriteResponse>(`${BASE}/${enc(id)}/close`, { ...opts, revision })),
  reopen: (id: string, revision: number, statusId?: string) =>
    call(() => api.post<TaskWriteResponse>(`${BASE}/${enc(id)}/reopen`, { statusId, revision })),
  reorder: (id: string, revision: number, to: { beforeId?: string; afterId?: string }) =>
    call(() => api.post<TaskWriteResponse>(`${BASE}/${enc(id)}/reorder`, { ...to, revision })),
  decide: (id: string, revision: number, optionId: string) =>
    call(() => api.post<TaskDecideResponse>(`${BASE}/${enc(id)}/decide`, { optionId, revision })),
  startChat: (id: string, revision: number) =>
    call(() => api.post<TaskStartChatResponse>(`${BASE}/${enc(id)}/start-chat`, { revision })),
  notifyManager: (project: string) => call(() => api.post<NotifyManagerResponse>(`${BASE}/notify-manager`, { project })),
  addLink: (id: string, revision: number, link: { kind: string; ref: string; label?: string | null }) =>
    call(() => api.post<TaskWriteResponse>(`${BASE}/${enc(id)}/links`, { ...link, revision })),
  removeLink: (id: string, revision: number, link: { kind: string; ref: string }) =>
    call(() => api.delete<TaskWriteResponse>(`${BASE}/${enc(id)}/links/${enc(taskLinkId(link))}?revision=${revision}`)),
  history: (id: string, filter: TaskHistoryFilter = "all") =>
    call(() => api.get<TaskHistoryItem[]>(`${BASE}/${enc(id)}/history?filter=${filter}`)),
  undo: (historyId: number) => call(() => api.post<TaskWriteResponse>(`${BASE}/history/${historyId}/undo`)),
  linkStates: (ids: string[]) =>
    call(() => api.get<TaskLinkStatesResponse>(`${BASE}/link-states?ids=${ids.map(enc).join(",")}`)),
  projects: () => call(() => api.get<TaskProjectSummary[]>(`${BASE}/projects`)),
  settings: (project: string) => call(() => api.get<TaskProjectSettings>(`${BASE}/projects/${enc(project)}/settings`)),
  saveSettings: (project: string, update: TaskProjectSettingsUpdate) =>
    call(() => api.put<TaskProjectSettings>(`${BASE}/projects/${enc(project)}/settings`, update)),
};
