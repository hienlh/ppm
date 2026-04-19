import { Hono } from "hono";
import {
  createWatcher, updateWatcher, deleteWatcher,
  getWatchersByConfigId, getWatcherById,
  getResultsByWatcherId, getResultById, softDeleteResult,
  getWatcherStats, insertResult, markResultRead, getUnreadCount,
} from "../../services/jira-watcher-db.service.ts";
import { jiraWatcherService, clampInterval } from "../../services/jira-watcher.service.ts";
import { jiraDebugService } from "../../services/jira-debug-session.service.ts";
import { getDecryptedCredentials } from "../../services/jira-config.service.ts";
import {
  getIssue, updateIssue, getTransitions, transitionIssue,
  searchText, searchIssues, getProjects, getFieldOptions, getAssignableUsers,
} from "../../services/jira-api-client.ts";
import { ok, err } from "../../types/api.ts";
import type { JiraWatcherMode } from "../../types/jira.ts";

/** Validate Jira issue key format (e.g. PROJ-123) */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;

export const jiraWatcherRoutes = new Hono();

// ── Watcher CRUD ──────────────────────────────────────────────────────

jiraWatcherRoutes.get("/watchers", (c) => {
  const configId = c.req.query("configId");
  if (!configId) return c.json(err("configId query param required"), 400);
  return c.json(ok(getWatchersByConfigId(parseInt(configId, 10))));
});

jiraWatcherRoutes.post("/watchers", async (c) => {
  const body = await c.req.json<{
    configId: number; name: string; jql: string;
    promptTemplate?: string; intervalMs?: number; mode?: JiraWatcherMode;
  }>();
  if (!body.configId || !body.name || !body.jql) {
    return c.json(err("configId, name, and jql are required"), 400);
  }
  if (body.mode && !["debug", "notify"].includes(body.mode)) {
    return c.json(err("mode must be 'debug' or 'notify'"), 400);
  }
  const interval = body.intervalMs ? clampInterval(body.intervalMs) : 120000;
  const watcher = createWatcher(body.configId, body.name, body.jql, {
    promptTemplate: body.promptTemplate,
    intervalMs: interval,
    mode: body.mode,
  });
  // Auto-start if enabled
  jiraWatcherService.startWatcher(watcher.id, watcher.intervalMs);
  return c.json(ok(watcher), 201);
});

jiraWatcherRoutes.put("/watchers/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<Partial<{
    name: string; jql: string; promptTemplate: string | null;
    intervalMs: number; enabled: boolean; mode: JiraWatcherMode;
  }>>();
  if (body.intervalMs !== undefined) body.intervalMs = clampInterval(body.intervalMs);
  if (body.mode !== undefined && !["debug", "notify"].includes(body.mode)) {
    return c.json(err("mode must be 'debug' or 'notify'"), 400);
  }
  const watcher = updateWatcher(id, body);
  if (!watcher) return c.json(err("Watcher not found"), 404);
  // Restart or stop based on enabled state
  if (watcher.enabled) {
    jiraWatcherService.startWatcher(watcher.id, watcher.intervalMs);
  } else {
    jiraWatcherService.stopWatcher(watcher.id);
  }
  return c.json(ok(watcher));
});

jiraWatcherRoutes.delete("/watchers/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  jiraWatcherService.stopWatcher(id);
  if (!deleteWatcher(id)) return c.json(err("Watcher not found"), 404);
  return c.json(ok({ deleted: true }));
});

jiraWatcherRoutes.post("/watchers/test-jql", async (c) => {
  const body = await c.req.json<{ configId: number; jql: string }>();
  if (!body.configId || !body.jql) return c.json(err("configId and jql required"), 400);
  const creds = getDecryptedCredentials(body.configId);
  if (!creds) return c.json(err("Invalid config"), 404);
  try {
    const response = await searchIssues(creds, body.jql, undefined, 20);
    return c.json(ok({ issues: response.issues, total: response.total }));
  } catch (e: any) {
    return c.json(err(`JQL search failed: ${e.message}`), 502);
  }
});

jiraWatcherRoutes.post("/watchers/:id/pull", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  try {
    const count = await jiraWatcherService.pollWatcher(id, "manual");
    return c.json(ok({ polled: true, newIssues: count }));
  } catch (e: any) {
    return c.json(err(`Poll failed: ${e.message}`), 502);
  }
});

jiraWatcherRoutes.post("/watchers/pull-all", async (c) => {
  try {
    const all = (await import("../../services/jira-watcher-db.service.ts")).getAllEnabledWatchers();
    let total = 0;
    for (const w of all) {
      try { total += await jiraWatcherService.pollWatcher(w.id, "manual"); } catch {}
    }
    return c.json(ok({ polled: true, watcherCount: all.length, newIssues: total }));
  } catch (e: any) {
    return c.json(err(`Pull failed: ${e.message}`), 502);
  }
});

// ── Debug sessions ───────────────────────────────────────────────────

jiraWatcherRoutes.post("/results/:id/debug", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({} as { prompt?: string }));
  const result = getResultById(id);
  if (!result) return c.json(err("Result not found"), 404);
  if (result.status !== "pending" && result.status !== "failed") {
    return c.json(err("Result must be pending or failed to debug"), 400);
  }
  try {
    jiraDebugService.enqueue(id, body.prompt);
    return c.json(ok({ queued: true }));
  } catch (e: any) {
    return c.json(err(e.message), 500);
  }
});

jiraWatcherRoutes.post("/results/:id/resume", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({} as { prompt?: string }));
  const result = getResultById(id);
  if (!result) return c.json(err("Result not found"), 404);
  if (result.status !== "failed") return c.json(err("Only failed results can be resumed"), 400);
  if (!result.sessionId) return c.json(err("No session to resume"), 400);
  try {
    jiraDebugService.resumeDebug(id, body.prompt);
    return c.json(ok({ resumed: true }));
  } catch (e: any) {
    return c.json(err(e.message), 500);
  }
});

jiraWatcherRoutes.post("/results/:id/cancel", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const cancelled = jiraDebugService.cancelDebug(id);
  if (!cancelled) return c.json(err("No active debug session for this result"), 404);
  return c.json(ok({ cancelled: true }));
});

jiraWatcherRoutes.patch("/results/:id/read", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!markResultRead(id)) return c.json(err("Result not found or already read"), 404);
  return c.json(ok({ read: true }));
});

jiraWatcherRoutes.get("/results/unread-count", (c) => {
  return c.json(ok({ count: getUnreadCount() }));
});

// ── Results ───────────────────────────────────────────────────────────

jiraWatcherRoutes.get("/results", (c) => {
  const watcherId = c.req.query("watcherId");
  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const results = getResultsByWatcherId(
    watcherId ? parseInt(watcherId, 10) : undefined,
    { status: status ?? undefined, limit, offset },
  );
  return c.json(ok(results));
});

jiraWatcherRoutes.get("/results/stats", (c) => {
  return c.json(ok(getWatcherStats()));
});

jiraWatcherRoutes.get("/results/:id", (c) => {
  const result = getResultById(parseInt(c.req.param("id"), 10));
  if (!result) return c.json(err("Result not found"), 404);
  return c.json(ok(result));
});

jiraWatcherRoutes.delete("/results/:id", (c) => {
  if (!softDeleteResult(parseInt(c.req.param("id"), 10))) {
    return c.json(err("Result not found"), 404);
  }
  return c.json(ok({ deleted: true }));
});

// ── Manual ticket tracking ────────────────────────────────────────────

jiraWatcherRoutes.post("/results/manual", async (c) => {
  const body = await c.req.json<{ configId: number; issueKey: string }>();
  if (!body.configId || !body.issueKey) return c.json(err("configId and issueKey required"), 400);
  if (!ISSUE_KEY_RE.test(body.issueKey)) return c.json(err("Invalid issueKey format"), 400);
  const creds = getDecryptedCredentials(body.configId);
  if (!creds) return c.json(err("Invalid config"), 404);
  try {
    const issue = await getIssue(creds, body.issueKey);
    const { inserted, resultId } = insertResult(
      null, issue.key, issue.fields.summary, issue.fields.updated, "manual",
    );
    if (!inserted) return c.json(err("Issue already tracked"), 409);
    return c.json(ok({ resultId, issueKey: issue.key }), 201);
  } catch (e: any) {
    return c.json(err(`Jira API error: ${e.message}`), 502);
  }
});

// ── Search ────────────────────────────────────────────────────────────

jiraWatcherRoutes.get("/search/:configId", async (c) => {
  const configId = parseInt(c.req.param("configId"), 10);
  const q = c.req.query("q") ?? "";
  if (!q) return c.json(err("q query param required"), 400);
  const creds = getDecryptedCredentials(configId);
  if (!creds) return c.json(err("Invalid config"), 404);
  try {
    const results = await searchText(creds, q);
    return c.json(ok(results));
  } catch (e: any) {
    return c.json(err(`Search failed: ${e.message}`), 502);
  }
});

// ── Ticket proxy ──────────────────────────────────────────────────────

jiraWatcherRoutes.get("/ticket/:configId/:issueKey", async (c) => {
  const issueKey = c.req.param("issueKey");
  if (!ISSUE_KEY_RE.test(issueKey)) return c.json(err("Invalid issueKey format"), 400);
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  try {
    const issue = await getIssue(creds, issueKey);
    return c.json(ok(issue));
  } catch (e: any) {
    return c.json(err(`Jira error: ${e.message}`), 502);
  }
});

jiraWatcherRoutes.put("/ticket/:configId/:issueKey", async (c) => {
  const issueKey = c.req.param("issueKey");
  if (!ISSUE_KEY_RE.test(issueKey)) return c.json(err("Invalid issueKey format"), 400);
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  const body = await c.req.json<{ fields: Record<string, unknown> }>();
  try {
    await updateIssue(creds, issueKey, body.fields ?? body);
    return c.json(ok({ updated: true }));
  } catch (e: any) {
    return c.json(err(`Jira error: ${e.message}`), 502);
  }
});

jiraWatcherRoutes.get("/ticket/:configId/:issueKey/transitions", async (c) => {
  const issueKey = c.req.param("issueKey");
  if (!ISSUE_KEY_RE.test(issueKey)) return c.json(err("Invalid issueKey format"), 400);
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  try {
    const transitions = await getTransitions(creds, issueKey);
    return c.json(ok(transitions));
  } catch (e: any) {
    return c.json(err(`Jira error: ${e.message}`), 502);
  }
});

jiraWatcherRoutes.post("/ticket/:configId/:issueKey/transition", async (c) => {
  const issueKey = c.req.param("issueKey");
  if (!ISSUE_KEY_RE.test(issueKey)) return c.json(err("Invalid issueKey format"), 400);
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  const body = await c.req.json<{ transitionId: string }>();
  if (!body.transitionId) return c.json(err("transitionId required"), 400);
  try {
    await transitionIssue(creds, issueKey, body.transitionId);
    return c.json(ok({ transitioned: true }));
  } catch (e: any) {
    return c.json(err(`Jira error: ${e.message}`), 502);
  }
});

// ── Metadata for filter builder ───────────────────────────────────────

jiraWatcherRoutes.get("/metadata/:configId/projects", async (c) => {
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  try { return c.json(ok(await getProjects(creds))); }
  catch (e: any) { return c.json(err(e.message), 502); }
});

jiraWatcherRoutes.get("/metadata/:configId/assignees", async (c) => {
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  try { return c.json(ok(await getAssignableUsers(creds))); }
  catch (e: any) { return c.json(err(e.message), 502); }
});

jiraWatcherRoutes.get("/metadata/:configId/:field", async (c) => {
  const creds = getDecryptedCredentials(parseInt(c.req.param("configId"), 10));
  if (!creds) return c.json(err("Invalid config"), 404);
  const field = c.req.param("field") as "issuetype" | "priority" | "status";
  if (!["issuetype", "priority", "status"].includes(field)) {
    return c.json(err("Invalid field"), 400);
  }
  try { return c.json(ok(await getFieldOptions(creds, field))); }
  catch (e: any) { return c.json(err(e.message), 502); }
});
