/** `/api/logs` from the browser. Every route is behind PPM's auth; nothing here talks to GitHub. */
import { api } from "@/lib/api-client";
import { logsQueryString } from "@/lib/logs/logs-view-model";
import type { LogEntry, LogSourceId } from "../../../shared/logs-model";
import type {
  DuplicateSearchResult, LogIssuesResult, LogIssuesSummary, LogQueryParams, LogQueryResult, ReportDraft,
  ReportDraftRequest,
} from "../../../shared/logs-api";

export const fetchLogs = (p: LogQueryParams, signal?: AbortSignal) =>
  api.get<LogQueryResult>(`/api/logs?${logsQueryString(p)}`, { signal });

/** Up to `n` records of `src` each side of the first and last of `ids`. */
export const fetchAround = (ids: readonly string[], n: number, src: LogSourceId | "all") =>
  api.get<{ before: LogEntry[]; after: LogEntry[] }>(
    `/api/logs/around?ids=${encodeURIComponent(ids.join(","))}&n=${n}&src=${src}`,
  );

export const fetchIssues = () => api.get<LogIssuesResult>("/api/logs/issues");
export const fetchIssuesSummary = () => api.get<LogIssuesSummary>("/api/logs/issues/summary");
export const analyzeIssues = (full: boolean) => api.post<{ started: boolean }>("/api/logs/issues/analyze", { full });
export const setIssuesAuto = (on: boolean) => api.post<{ auto: boolean }>("/api/logs/issues/auto", { on });
export const dismissIssue = (id: string, dismissed: boolean) =>
  api.post<Record<string, never>>(`/api/logs/issues/${encodeURIComponent(id)}/${dismissed ? "dismiss" : "undismiss"}`);
export const undismissAllIssues = () => api.post<Record<string, never>>("/api/logs/issues/undismiss-all");

export const draftReport = (req: ReportDraftRequest) => api.post<ReportDraft>("/api/logs/report/draft", req);
export const fetchEnvironment = () => api.get<Array<[string, string]>>("/api/logs/environment");
export const fetchRepoLabels = () => api.get<string[]>("/api/logs/github/labels");
export const searchDuplicates = (q: string) =>
  api.get<DuplicateSearchResult>(`/api/logs/github/duplicates?q=${encodeURIComponent(q)}`);
