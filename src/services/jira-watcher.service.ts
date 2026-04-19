import { searchIssues, JiraApiError, getRateLimitState } from "./jira-api-client.ts";
import { getDecryptedCredentials } from "./jira-config.service.ts";
import { getAllEnabledWatchers, insertResult } from "./jira-watcher-db.service.ts";
import { jiraDebugService } from "./jira-debug-session.service.ts";
import { getDb } from "./db.service.ts";
import { notificationService } from "./notification.service.ts";
import type { JiraWatcherRow, JiraIssue } from "../types/jira.ts";

const INTERVAL_MIN = 30_000;   // 30s
const INTERVAL_MAX = 3_600_000; // 60m
const RATE_LIMIT_PAUSE_MS = 300_000; // 5min

export function clampInterval(ms: number): number {
  return Math.max(INTERVAL_MIN, Math.min(INTERVAL_MAX, ms));
}

class JiraWatcherService {
  private activeTimers = new Map<number, Timer>();

  async startAll(): Promise<void> {
    const watchers = getAllEnabledWatchers();
    for (const w of watchers) this.startWatcher(w.id, w.interval_ms);
    if (watchers.length) console.log(`[jira] Started ${watchers.length} watcher(s)`);
  }

  stopAll(): void {
    for (const [id, timer] of this.activeTimers) {
      clearInterval(timer);
      this.activeTimers.delete(id);
    }
  }

  startWatcher(id: number, intervalMs: number): void {
    if (this.activeTimers.has(id)) this.stopWatcher(id);
    const interval = clampInterval(intervalMs);
    const timer = setInterval(() => this.pollWatcher(id).catch((e) =>
      console.warn(`[jira] Poll error watcher ${id}:`, e.message),
    ), interval);
    this.activeTimers.set(id, timer);
  }

  stopWatcher(id: number): void {
    const timer = this.activeTimers.get(id);
    if (timer) { clearInterval(timer); this.activeTimers.delete(id); }
  }

  isRunning(id: number): boolean {
    return this.activeTimers.has(id);
  }

  async pollWatcher(watcherId: number, source: "auto" | "manual" = "auto"): Promise<number> {
    const watcher = getDb()
      .query("SELECT * FROM jira_watchers WHERE id = ?")
      .get(watcherId) as JiraWatcherRow | null;
    if (!watcher) return 0;

    const creds = getDecryptedCredentials(watcher.jira_config_id);
    if (!creds) { console.warn(`[jira] No credentials for config ${watcher.jira_config_id}`); return 0; }

    // Check rate limit pause
    const rlState = getRateLimitState(creds.baseUrl);
    if (rlState.pausedUntil && Date.now() < rlState.pausedUntil) return 0;

    const isFirstPoll = !watcher.last_polled_at;

    try {
      // First auto-poll = baseline only: just set last_polled_at, skip inserts
      // Manual pull always fetches everything
      if (isFirstPoll && source === "auto") {
        await searchIssues(creds, watcher.jql); // validate JQL works
        getDb().query("UPDATE jira_watchers SET last_polled_at = datetime('now') WHERE id = ?").run(watcherId);
        console.log(`[jira] Watcher "${watcher.name}": baseline poll done (skipped inserts)`);
        return 0;
      }

      const response = await searchIssues(creds, watcher.jql);
      let newCount = 0;
      const newResultIds: number[] = [];

      for (const issue of response.issues) {
        let inserted: boolean, resultId: number | null;
        try {
          ({ inserted, resultId } = insertResult(
            watcher.id, issue.key,
            issue.fields.summary, issue.fields.updated,
            "watcher", source,
          ));
        } catch (e: any) {
          console.error(`[jira] insertResult FK error for watcher ${watcher.id}, issue ${issue.key}:`, e.message);
          throw e;
        }
        if (inserted && resultId) {
          newCount++;
          newResultIds.push(resultId);

          if (watcher.mode === "notify") {
            notificationService.broadcast("done", {
              title: `Jira: ${issue.key}`,
              body: issue.fields.summary,
              project: "", sessionId: "",
            }).catch(() => {});
          }
        }
      }

      // Auto-enqueue debug for new issues (≤5 to avoid flooding)
      if (watcher.mode === "debug" && source === "auto" && newResultIds.length > 0 && newResultIds.length <= 5) {
        for (const rid of newResultIds) {
          try { jiraDebugService.enqueue(rid); } catch (e: any) {
            console.warn(`[jira] enqueue debug error resultId=${rid}:`, e.message);
          }
        }
      }

      // Update last_polled_at
      getDb().query("UPDATE jira_watchers SET last_polled_at = datetime('now') WHERE id = ?").run(watcherId);
      if (newCount) console.log(`[jira] Watcher "${watcher.name}": ${newCount} new issue(s)`);
      return newCount;
    } catch (e) {
      if (e instanceof JiraApiError && e.status === 429) {
        console.warn(`[jira] Rate limited — pausing watchers for config ${watcher.jira_config_id}`);
        this.pauseConfigWatchers(watcher.jira_config_id);
      }
      throw e;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  buildPrompt(watcher: JiraWatcherRow, issue: JiraIssue): string {
    if (watcher.prompt_template) {
      return watcher.prompt_template
        .replace(/\{issue_key\}/g, issue.key)
        .replace(/\{summary\}/g, issue.fields.summary)
        .replace(/\{description\}/g, issue.fields.description ?? "(no description)")
        .replace(/\{status\}/g, issue.fields.status.name)
        .replace(/\{priority\}/g, issue.fields.priority?.name ?? "None");
    }
    return `Debug Jira issue ${issue.key}: ${issue.fields.summary}\n\nDescription:\n${issue.fields.description ?? "(no description)"}`;
  }

  private pauseConfigWatchers(configId: number): void {
    const watchers = getDb()
      .query("SELECT id FROM jira_watchers WHERE jira_config_id = ? AND enabled = 1")
      .all(configId) as Array<{ id: number }>;
    for (const w of watchers) this.stopWatcher(w.id);
    // Re-start after pause
    setTimeout(() => {
      for (const w of watchers) {
        const row = getDb().query("SELECT * FROM jira_watchers WHERE id = ? AND enabled = 1")
          .get(w.id) as JiraWatcherRow | null;
        if (row) this.startWatcher(row.id, row.interval_ms);
      }
    }, RATE_LIMIT_PAUSE_MS);
  }

}

export const jiraWatcherService = new JiraWatcherService();
