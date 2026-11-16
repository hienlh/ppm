import type { Json } from "../mcp-http-endpoint.ts";
import { getProjects } from "../db.service.ts";
import {
  credentialsProblem, getAllConfigs, getDecryptedCredentials, JIRA_NO_TOKEN_MESSAGE,
} from "../jira-config.service.ts";
import { getWatchersByConfigId } from "../jira-watcher-db.service.ts";
import { JiraApiError, testConnection } from "../jira-api-client.ts";
import type { JiraConfig, JiraCredentials } from "../../types/jira.ts";
import { boundedJson, JIRA_TEST_WINDOW_MS, JIRA_TESTS_PER_WINDOW } from "./assistant-system-tool-definitions.ts";
import { errorResult } from "./assistant-tool-output.ts";

/**
 * `jira_config_get`: what Settings → Jira shows, per project, and on request whether the saved
 * login still works. The token never leaves: the answer carries `tokenSaved` only, the decrypted
 * credentials are used inside `test` and dropped, and a failed test answers with a status and a
 * reason of PPM's own wording — never Jira's response body, which may quote the request.
 *
 * A test sends the stored login only to the site the user configured, so it runs unasked; it is
 * rate-limited per Assistant session so a looping agent cannot hammer the user's Jira.
 */

export interface JiraToolDeps {
  configs: () => JiraConfig[];
  projects: () => Array<{ id: number; name: string }>;
  watcherCount: (configId: number) => number;
  credentials: (configId: number) => JiraCredentials | null;
  problem: (configId: number) => string;
  test: (creds: JiraCredentials) => Promise<unknown>;
  now: () => number;
}

export const realJiraToolDeps: JiraToolDeps = {
  configs: getAllConfigs,
  projects: () => getProjects().map((p) => ({ id: p.id, name: p.name })),
  watcherCount: (configId) => getWatchersByConfigId(configId).length,
  credentials: getDecryptedCredentials,
  problem: credentialsProblem,
  test: testConnection,
  now: Date.now,
};

/** Test times per session, oldest first, kept only inside the window. */
const testsBySession = new Map<string, number[]>();

/** Takes one test from `sessionId`'s allowance; false when the window's allowance is spent. */
export function takeJiraTest(sessionId: string, now: number): boolean {
  const recent = (testsBySession.get(sessionId) ?? []).filter((t) => now - t < JIRA_TEST_WINDOW_MS);
  if (recent.length >= JIRA_TESTS_PER_WINDOW) { testsBySession.set(sessionId, recent); return false; }
  recent.push(now);
  testsBySession.set(sessionId, recent);
  return true;
}

/** Tests only. */
export function _resetJiraTestLimit(): void {
  testsBySession.clear();
}

type TestOutcome = { ok: true } | { ok: false; status: number | null; reason: string };

/** A connection test's outcome in PPM's words; Jira's own error text is not passed on. */
async function runTest(creds: JiraCredentials, deps: JiraToolDeps): Promise<TestOutcome> {
  try {
    await deps.test(creds);
    return { ok: true };
  } catch (e) {
    if (e instanceof JiraApiError) {
      const reason = e.status === 401 ? "Jira refused the login (wrong e-mail or token, or the token was revoked)"
        : e.status === 403 ? "the account may not search issues on this site"
        : e.status === 429 ? "Jira is rate-limiting this site"
        : e.status === 404 ? "the site URL does not look like a Jira Cloud site"
        : "Jira answered with an error";
      return { ok: false, status: e.status, reason };
    }
    const name = (e as Error)?.name;
    return { ok: false, status: null, reason: name === "AbortError" || name === "TimeoutError" ? "the site did not answer in 15 seconds" : "the site could not be reached" };
  }
}

export async function jiraConfigGet(sessionId: string, args: Record<string, unknown>, deps: JiraToolDeps = realJiraToolDeps): Promise<Json> {
  if (args.project !== undefined && typeof args.project !== "string") return errorResult("`project` must be a project name.");
  if (args.test !== undefined && typeof args.test !== "boolean") return errorResult("`test` must be true or false.");
  const projects = deps.projects();
  const wanted = args.project ? projects.filter((p) => p.name === args.project) : projects;
  if (args.project && wanted.length === 0) return errorResult(`No registered project is named ${JSON.stringify(String(args.project).slice(0, 80))}; projects_list names them.`);
  const byProject = new Map(deps.configs().map((c) => [c.projectId, c]));

  let testsRefused = false;
  const rows = [];
  for (const project of wanted) {
    const c = byProject.get(project.id);
    if (!c) { rows.push({ project: project.name, configured: false }); continue; }
    // Decrypted only to learn whether it can be; the credentials stay in this frame.
    const creds = c.hasToken ? deps.credentials(c.id) : null;
    const problem = !c.hasToken ? JIRA_NO_TOKEN_MESSAGE : creds ? null : deps.problem(c.id);
    let test: TestOutcome | "rate-limited" | undefined;
    if (args.test === true && creds) {
      if (takeJiraTest(sessionId, deps.now())) test = await runTest(creds, deps);
      else { test = "rate-limited"; testsRefused = true; }
    }
    rows.push({
      project: project.name,
      configured: true,
      baseUrl: c.baseUrl,
      email: c.email,
      tokenSaved: c.hasToken,
      watchers: deps.watcherCount(c.id),
      credentialsProblem: problem,
      ...(test !== undefined ? { test } : args.test === true ? { test: "not run: the saved login cannot be used" } : {}),
    });
  }
  return boundedJson({
    projects: rows,
    ...(testsRefused ? { note: `Connection tests are limited to ${JIRA_TESTS_PER_WINDOW} per ${JIRA_TEST_WINDOW_MS / 60_000} minutes in this conversation; try again later.` } : {}),
  }, { key: "projects", list: rows });
}
