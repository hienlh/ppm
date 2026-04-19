import { create } from "zustand";
import { api } from "@/lib/api-client";
import type {
  JiraConfig, JiraWatcher, JiraWatchResult, JiraWatcherMode, JiraIssue,
} from "../../../src/types/jira";

export interface ProjectWithId {
  id: number;
  name: string;
  path: string;
  color?: string | null;
}

interface JiraStore {
  // Projects (with DB ids)
  projectsWithIds: ProjectWithId[];
  loadProjectsWithIds: () => Promise<void>;

  // Config
  configs: JiraConfig[];
  selectedProjectId: number | null;
  loadConfigs: () => Promise<void>;
  saveConfig: (projectId: number, data: { baseUrl: string; email: string; token: string }) => Promise<void>;
  deleteConfig: (projectId: number) => Promise<void>;
  testConnection: (projectId: number) => Promise<boolean>;
  setSelectedProjectId: (id: number | null) => void;

  // Watchers
  watchers: JiraWatcher[];
  loadWatchers: (configId: number) => Promise<void>;
  createWatcher: (data: { configId: number; name: string; jql: string; promptTemplate?: string; intervalMs?: number; mode?: JiraWatcherMode }) => Promise<void>;
  updateWatcher: (id: number, data: Partial<{ name: string; jql: string; promptTemplate: string | null; intervalMs: number; enabled: boolean; mode: JiraWatcherMode }>) => Promise<void>;
  deleteWatcher: (id: number) => Promise<void>;
  toggleWatcher: (id: number, enabled: boolean) => Promise<void>;
  pullWatcher: (id: number) => Promise<{ newIssues: number }>;
  testJql: (configId: number, jql: string) => Promise<{ issues: JiraIssue[]; total: number }>;

  // Results
  results: JiraWatchResult[];
  loadResults: (watcherId?: number, status?: string, limit?: number, offset?: number) => Promise<void>;
  softDeleteResult: (id: number) => Promise<void>;

  // Debug + Unread
  startDebug: (resultId: number, prompt?: string) => Promise<void>;
  resumeDebug: (resultId: number) => Promise<void>;
  cancelDebug: (resultId: number) => Promise<void>;
  markRead: (resultId: number) => Promise<void>;
  unreadCount: number;
  loadUnreadCount: () => Promise<void>;
}

export const useJiraStore = create<JiraStore>((set, get) => ({
  projectsWithIds: [],
  configs: [],
  selectedProjectId: null,
  watchers: [],
  results: [],
  unreadCount: 0,

  setSelectedProjectId: (id) => set({ selectedProjectId: id }),

  loadProjectsWithIds: async () => {
    const rows = await api.get<ProjectWithId[]>("/api/jira/config/projects");
    set({ projectsWithIds: Array.isArray(rows) ? rows : [] });
  },

  loadConfigs: async () => {
    const configs = await api.get<JiraConfig[]>("/api/jira/config");
    set({ configs });
  },

  saveConfig: async (projectId, data) => {
    await api.put(`/api/jira/config/${projectId}`, data);
    await get().loadConfigs();
  },

  deleteConfig: async (projectId) => {
    await api.del(`/api/jira/config/${projectId}`);
    set((s) => ({ configs: s.configs.filter((c) => c.projectId !== projectId), watchers: [] }));
  },

  testConnection: async (projectId) => {
    const res = await api.post<{ connected: boolean }>(`/api/jira/config/${projectId}/test`);
    return res.connected;
  },

  loadWatchers: async (configId) => {
    const watchers = await api.get<JiraWatcher[]>(`/api/jira/watchers?configId=${configId}`);
    set({ watchers });
  },

  createWatcher: async (data) => {
    await api.post("/api/jira/watchers", data);
    if (data.configId) await get().loadWatchers(data.configId);
  },

  updateWatcher: async (id, data) => {
    await api.put(`/api/jira/watchers/${id}`, data);
    // Refresh — find configId from current watchers
    const w = get().watchers.find((w) => w.id === id);
    if (w) await get().loadWatchers(w.jiraConfigId);
  },

  deleteWatcher: async (id) => {
    const w = get().watchers.find((w) => w.id === id);
    await api.del(`/api/jira/watchers/${id}`);
    if (w) await get().loadWatchers(w.jiraConfigId);
  },

  toggleWatcher: async (id, enabled) => {
    // Optimistic update
    set((s) => ({ watchers: s.watchers.map((w) => w.id === id ? { ...w, enabled } : w) }));
    try {
      await api.put(`/api/jira/watchers/${id}`, { enabled });
    } catch {
      set((s) => ({ watchers: s.watchers.map((w) => w.id === id ? { ...w, enabled: !enabled } : w) }));
    }
  },

  pullWatcher: async (id) => {
    const result = await api.post<{ newIssues: number }>(`/api/jira/watchers/${id}/pull`);
    // Refresh results so the UI shows newly pulled tickets
    await get().loadResults();
    return result;
  },

  testJql: async (configId, jql) => {
    return await api.post<{ issues: JiraIssue[]; total: number }>("/api/jira/watchers/test-jql", { configId, jql });
  },

  loadResults: async (watcherId, status, limit = 50, offset = 0) => {
    const params = new URLSearchParams();
    if (watcherId !== undefined) params.set("watcherId", String(watcherId));
    if (status) params.set("status", status);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const results = await api.get<JiraWatchResult[]>(`/api/jira/results?${params}`);
    set(offset > 0 ? (s) => ({ results: [...s.results, ...results] }) : { results });
  },

  softDeleteResult: async (id) => {
    set((s) => ({ results: s.results.filter((r) => r.id !== id) }));
    try { await api.del(`/api/jira/results/${id}`); } catch {}
  },

  startDebug: async (resultId, prompt) => {
    // Optimistic update before API call
    const prev = get().results.find((r) => r.id === resultId)?.status;
    set((s) => ({
      results: s.results.map((r) => r.id === resultId ? { ...r, status: "queued" as const } : r),
    }));
    try {
      await api.post(`/api/jira/results/${resultId}/debug`, prompt ? { prompt } : {});
    } catch {
      // Rollback on failure
      set((s) => ({
        results: s.results.map((r) => r.id === resultId ? { ...r, status: (prev ?? "pending") as any } : r),
      }));
    }
  },

  resumeDebug: async (resultId) => {
    const prev = get().results.find((r) => r.id === resultId)?.status;
    set((s) => ({
      results: s.results.map((r) => r.id === resultId ? { ...r, status: "queued" as const } : r),
    }));
    try {
      await api.post(`/api/jira/results/${resultId}/resume`);
    } catch {
      set((s) => ({
        results: s.results.map((r) => r.id === resultId ? { ...r, status: (prev ?? "failed") as any } : r),
      }));
    }
  },

  cancelDebug: async (resultId) => {
    try {
      await api.post(`/api/jira/results/${resultId}/cancel`);
      await get().loadResults();
    } catch {}
  },

  markRead: async (resultId) => {
    // Optimistic update
    set((s) => ({
      results: s.results.map((r) => r.id === resultId ? { ...r, readAt: new Date().toISOString() } : r),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }));
    try { await api.patch(`/api/jira/results/${resultId}/read`); } catch {}
  },

  loadUnreadCount: async () => {
    try {
      const res = await api.get<{ count: number }>("/api/jira/results/unread-count");
      set({ unreadCount: res.count });
    } catch {}
  },
}));
