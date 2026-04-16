import type {
  JiraCredentials,
  JiraIssue,
  JiraSearchResponse,
  JiraTransition,
  JiraRateLimitState,
} from "../types/jira.ts";

// ── Error class ───────────────────────────────────────────────────────

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
    public rateLimitRemaining?: number,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

// ── Rate limit state per config (keyed by baseUrl) ────────────────────

const rateLimitStates = new Map<string, JiraRateLimitState>();

export function getRateLimitState(baseUrl: string): JiraRateLimitState {
  return rateLimitStates.get(baseUrl) ?? {
    remaining: null, limit: null, resetAt: null,
    backingOff: false, pausedUntil: null,
  };
}

function extractRateLimits(headers: Headers, baseUrl: string): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  const state = getRateLimitState(baseUrl);
  if (remaining !== null) state.remaining = parseInt(remaining, 10);
  if (limit !== null) state.limit = parseInt(limit, 10);
  // Check if backing off needed
  if (state.remaining !== null && state.limit !== null && state.limit > 0) {
    state.backingOff = state.remaining / state.limit < 0.2;
  }
  rateLimitStates.set(baseUrl, state);
}

// ── Auth helper ───────────────────────────────────────────────────────

function buildAuthHeader(creds: JiraCredentials): string {
  return "Basic " + Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
}

// ── Core fetch wrapper ────────────────────────────────────────────────

async function jiraFetch<T>(
  creds: JiraCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: buildAuthHeader(creds),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    extractRateLimits(res.headers, creds.baseUrl);

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "300", 10);
      const state = getRateLimitState(creds.baseUrl);
      state.pausedUntil = Date.now() + retryAfter * 1000;
      rateLimitStates.set(creds.baseUrl, state);
      throw new JiraApiError("Rate limited by Jira", 429, retryAfter);
    }

    if (res.status === 204) return undefined as T; // void responses (PUT update)

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JiraApiError(
        `Jira API ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        undefined,
        getRateLimitState(creds.baseUrl).remaining ?? undefined,
      );
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Public API ────────────────────────────────────────────────────────

const DEFAULT_FIELDS = "summary,status,priority,assignee,description,updated,created";

export async function searchIssues(
  creds: JiraCredentials,
  jql: string,
  fields = DEFAULT_FIELDS,
  maxResults = 50,
  nextPageToken?: string,
): Promise<JiraSearchResponse> {
  const body: Record<string, unknown> = {
    jql, fields: fields.split(","), maxResults,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return jiraFetch<JiraSearchResponse>(creds, "POST", "/rest/api/3/search/jql", body);
}

export async function getIssue(
  creds: JiraCredentials,
  issueKey: string,
  fields = DEFAULT_FIELDS,
): Promise<JiraIssue> {
  return jiraFetch<JiraIssue>(creds, "GET", `/rest/api/3/issue/${issueKey}?fields=${fields}`);
}

export async function updateIssue(
  creds: JiraCredentials,
  issueKey: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await jiraFetch<void>(creds, "PUT", `/rest/api/3/issue/${issueKey}`, { fields });
}

export async function getTransitions(
  creds: JiraCredentials,
  issueKey: string,
): Promise<JiraTransition[]> {
  const res = await jiraFetch<{ transitions: JiraTransition[] }>(
    creds, "GET", `/rest/api/3/issue/${issueKey}/transitions`,
  );
  return res.transitions;
}

export async function transitionIssue(
  creds: JiraCredentials,
  issueKey: string,
  transitionId: string,
): Promise<void> {
  await jiraFetch<void>(creds, "POST", `/rest/api/3/issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
}

export async function testConnection(creds: JiraCredentials): Promise<boolean> {
  // Use bounded JQL — unbounded queries return 400 on /search/jql
  await searchIssues(creds, "created >= -30d ORDER BY created DESC", "summary", 1);
  return true;
}

/** Escape JQL special characters in user input */
function escapeJql(value: string): string {
  // Remove control characters, escape JQL reserved chars
  return value
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[\\'"{}()\[\]+\-&|!~*?^]/g, "\\$&");
}

export async function searchText(
  creds: JiraCredentials,
  query: string,
  maxResults = 20,
): Promise<JiraSearchResponse> {
  const jql = `text ~ "${escapeJql(query)}" ORDER BY updated DESC`;
  return searchIssues(creds, jql, DEFAULT_FIELDS, maxResults);
}

/** Fetch Jira project list for filter builder */
export async function getProjects(
  creds: JiraCredentials,
): Promise<Array<{ key: string; name: string }>> {
  return jiraFetch<Array<{ key: string; name: string }>>(
    creds, "GET", "/rest/api/3/project/search?maxResults=100",
  ).then((res: any) => (res.values ?? res).map((p: any) => ({ key: p.key, name: p.name })));
}

/** Fetch metadata for filter builder (issue types, priorities, statuses) */
export async function getFieldOptions(
  creds: JiraCredentials,
  fieldName: "issuetype" | "priority" | "status",
): Promise<Array<{ id: string; name: string }>> {
  if (fieldName === "issuetype") {
    return jiraFetch<Array<{ id: string; name: string }>>(creds, "GET", "/rest/api/3/issuetype");
  }
  if (fieldName === "priority") {
    return jiraFetch<Array<{ id: string; name: string }>>(creds, "GET", "/rest/api/3/priority");
  }
  // statuses
  return jiraFetch<Array<any>>(creds, "GET", "/rest/api/3/status")
    .then((list) => list.map((s: any) => ({ id: s.id, name: s.name })));
}
