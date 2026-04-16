// ── DB row types (snake_case, matches SQLite columns) ─────────────────

export interface JiraConfigRow {
  id: number;
  project_id: number;
  base_url: string;
  email: string;
  api_token_encrypted: string;
  created_at: string;
}

export interface JiraWatcherRow {
  id: number;
  jira_config_id: number;
  name: string;
  jql: string;
  prompt_template: string | null;
  enabled: number; // 0 | 1
  mode: string; // "debug" | "notify"
  interval_ms: number;
  last_polled_at: string | null;
  created_at: string;
}

export interface JiraWatchResultRow {
  id: number;
  watcher_id: number | null;
  issue_key: string;
  issue_summary: string | null;
  issue_updated: string | null;
  session_id: string | null;
  status: JiraResultStatus;
  ai_summary: string | null;
  source: string; // "watcher" | "manual"
  deleted: number; // 0 | 1
  created_at: string;
}

export type JiraResultStatus = "pending" | "running" | "done" | "failed";
export type JiraWatcherMode = "debug" | "notify";

// ── API response types (camelCase for frontend) ───────────────────────

export interface JiraConfig {
  id: number;
  projectId: number;
  baseUrl: string;
  email: string;
  hasToken: boolean; // never expose actual token
  createdAt: string;
}

export interface JiraWatcher {
  id: number;
  jiraConfigId: number;
  name: string;
  jql: string;
  promptTemplate: string | null;
  enabled: boolean;
  mode: JiraWatcherMode;
  intervalMs: number;
  lastPolledAt: string | null;
  createdAt: string;
}

export interface JiraWatchResult {
  id: number;
  watcherId: number | null;
  issueKey: string;
  issueSummary: string | null;
  issueUpdated: string | null;
  sessionId: string | null;
  status: JiraResultStatus;
  aiSummary: string | null;
  source: string;
  createdAt: string;
}

// ── Jira Cloud API response shapes (subset we use) ────────────────────

export interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string; id: string };
    priority: { name: string; id: string } | null;
    assignee: { accountId: string; displayName: string; emailAddress?: string } | null;
    updated: string;
    created: string;
  };
}

export interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  nextPageToken?: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

// ── Credentials (internal, decrypted for API calls) ───────────────────

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string; // plaintext (decrypted)
}

// ── Rate limit tracking ───────────────────────────────────────────────

export interface JiraRateLimitState {
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  backingOff: boolean;
  pausedUntil: number | null; // epoch ms
}
