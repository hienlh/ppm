/**
 * Live state of Jira links, read with the task's own project's Jira config only (a key is never
 * looked up on another project's site): one search per up to 50 keys. A key the batch query rejects
 * (Jira refuses the whole `key in (…)` when one key does not exist) is retried on its own, so one
 * typo cannot blank every other key. While the site has paused us (`pausedUntil`), nothing is asked
 * and `null` comes back: the cache keeps what it has. Running low on the rate limit (`backingOff`)
 * does not stop reads — that flag only clears on a later response — the two-minute cache and the
 * batching already keep this reader to a handful of requests.
 */
import { getDb } from "../../db.service.ts";
import { projectKey as keyOf } from "../../project-name-for-path.ts";
import { getConfigByProjectId, getDecryptedCredentials } from "../../jira-config.service.ts";
import { getIssue, getRateLimitState, JiraApiError, searchIssues } from "../../jira-api-client.ts";
import type { JiraCredentials, JiraIssue } from "../../../types/jira.ts";
import { parseJiraKey } from "../../../shared/ppm-tasks-refs.ts";
import type { ReadResult } from "./github-pr-link-state-reader.ts";

export const JIRA_BATCH = 50;
const FIELDS = "summary,status,assignee,updated";

export interface JiraLinkState {
  status: string;
  category: "new" | "indeterminate" | "done" | null;
  assignee: string | null;
  updated: string | null;
  summary: string;
}

/** The Jira transport, swapped by tests. */
export interface JiraTransport {
  credentialsFor(projectKey: string): { creds: JiraCredentials; baseUrl: string } | { problem: string };
  /** The site asked for a pause that has not ended. */
  paused(baseUrl: string, now: number): boolean;
  search(creds: JiraCredentials, keys: string[]): Promise<JiraIssue[]>;
  get(creds: JiraCredentials, key: string): Promise<JiraIssue>;
}

function projectIdFor(projectKey: string): number | null {
  const rows = getDb().query("SELECT id, path FROM projects").all() as Array<{ id: number; path: string }>;
  return rows.find((r) => keyOf(r.path) === projectKey)?.id ?? null;
}

export const liveJiraTransport: JiraTransport = {
  credentialsFor(projectKey) {
    const id = projectIdFor(projectKey);
    const config = id === null ? null : getConfigByProjectId(id);
    if (!config) return { problem: "no Jira config for this project" };
    const creds = getDecryptedCredentials(config.id);
    if (!creds) return { problem: "Jira credentials unavailable" };
    return { creds, baseUrl: config.baseUrl };
  },
  paused(baseUrl, now) {
    const s = getRateLimitState(baseUrl);
    return s.pausedUntil !== null && Number(s.pausedUntil) > now;
  },
  search: async (creds, keys) => (await searchIssues(creds, `key in (${keys.join(",")})`, FIELDS, keys.length)).issues,
  get: (creds, key) => getIssue(creds, key, FIELDS),
};

export function mapIssue(issue: JiraIssue): JiraLinkState {
  const status = issue.fields.status as JiraIssue["fields"]["status"] & { statusCategory?: { key?: string } };
  const cat = status?.statusCategory?.key;
  return {
    status: String(status?.name ?? ""),
    category: cat === "new" || cat === "indeterminate" || cat === "done" ? cat : null,
    assignee: issue.fields.assignee?.displayName ?? null,
    updated: issue.fields.updated ?? null,
    summary: String(issue.fields.summary ?? "").slice(0, 300),
  };
}

const errorText = (e: unknown): string => (e instanceof JiraApiError ? `Jira ${e.status}` : "Jira request failed");

/**
 * States of these Jira keys in this project, keyed by the ref as given; null when the site asks to
 * back off (nothing was read).
 */
export async function readJiraStates(
  projectKey: string, refs: readonly string[], transport: JiraTransport = liveJiraTransport, now = Date.now(),
): Promise<Map<string, ReadResult> | null> {
  const out = new Map<string, ReadResult>();
  const byKey = new Map<string, string>();
  for (const ref of refs) {
    const key = parseJiraKey(ref);
    if (key) byKey.set(key, ref);
    else out.set(ref, { state: null, error: "not a Jira key" });
  }
  if (byKey.size === 0) return out;
  const access = transport.credentialsFor(projectKey);
  if ("problem" in access) {
    for (const ref of byKey.values()) out.set(ref, { state: null, error: access.problem });
    return out;
  }
  if (transport.paused(access.baseUrl, now)) return null;
  const keys = [...byKey.keys()];
  const put = (issue: JiraIssue) => {
    const ref = byKey.get(issue.key.toUpperCase());
    if (ref) out.set(ref, { state: mapIssue(issue) as unknown as Record<string, unknown>, error: null });
  };
  for (let i = 0; i < keys.length; i += JIRA_BATCH) {
    const batch = keys.slice(i, i + JIRA_BATCH);
    try {
      for (const issue of await transport.search(access.creds, batch)) put(issue);
    } catch (e) {
      if (!(e instanceof JiraApiError && e.status === 400 && batch.length > 1)) {
        for (const k of batch) out.set(byKey.get(k)!, { state: null, error: errorText(e) });
        continue;
      }
      let limited = false;
      for (const k of batch) {
        if (limited) { out.set(byKey.get(k)!, { state: null, error: "Jira 429" }); continue; }
        try { put(await transport.get(access.creds, k)); } catch (inner) {
          // Rate limited: the rest of the batch waits for the next read rather than piling on.
          limited = inner instanceof JiraApiError && inner.status === 429;
          out.set(byKey.get(k)!, { state: null, error: inner instanceof JiraApiError && inner.status === 404 ? "issue not found or no access" : errorText(inner) });
        }
      }
    }
  }
  for (const ref of byKey.values()) if (!out.has(ref)) out.set(ref, { state: null, error: "issue not found or no access" });
  return out;
}
