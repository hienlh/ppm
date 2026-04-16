import { searchIssues, JiraApiError, getRateLimitState } from "./jira-api-client.ts";
import { getDecryptedCredentials } from "./jira-config.service.ts";
import {
  getAllEnabledWatchers, insertResult, updateResultStatus,
  getRunningResults, getWatcherById as dbGetWatcherById,
} from "./jira-watcher-db.service.ts";
import { getDb, createBotTask } from "./db.service.ts";
import { notificationService } from "./notification.service.ts";
import type { JiraWatcherRow, JiraIssue, JiraRateLimitState } from "../types/jira.ts";

const INTERVAL_MIN = 30_000;   // 30s
const INTERVAL_MAX = 3_600_000; // 60m
const RATE_LIMIT_PAUSE_MS = 300_000; // 5min

export function clampInterval(ms: number): number {
  return Math.max(INTERVAL_MIN, Math.min(INTERVAL_MAX, ms));
}

class JiraWatcherService {
  private activeTimers = new Map<number, Timer>();
  private syncTimer: Timer | null = null;

  async startAll(): Promise<void> {
    const watchers = getAllEnabledWatchers();
    for (const w of watchers) this.startWatcher(w.id, w.interval_ms);
    this.startSyncLoop();
    if (watchers.length) console.log(`[jira] Started ${watchers.length} watcher(s)`);
  }

  stopAll(): void {
    for (const [id, timer] of this.activeTimers) {
      clearInterval(timer);
      this.activeTimers.delete(id);
    }
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
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

  async pollWatcher(watcherId: number): Promise<number> {
    const watcher = getDb()
      .query("SELECT * FROM jira_watchers WHERE id = ?")
      .get(watcherId) as JiraWatcherRow | null;
    if (!watcher) return 0;

    const creds = getDecryptedCredentials(watcher.jira_config_id);
    if (!creds) { console.warn(`[jira] No credentials for config ${watcher.jira_config_id}`); return 0; }

    // Check rate limit pause
    const rlState = getRateLimitState(creds.baseUrl);
    if (rlState.pausedUntil && Date.now() < rlState.pausedUntil) return 0;

    try {
      const response = await searchIssues(creds, watcher.jql);
      let newCount = 0;
      for (const issue of response.issues) {
        let inserted: boolean, resultId: number | null;
        try {
          ({ inserted, resultId } = insertResult(
            watcher.id, issue.key,
            issue.fields.summary, issue.fields.updated,
          ));
        } catch (e: any) {
          console.error(`[jira] insertResult FK error for watcher ${watcher.id}, issue ${issue.key}:`, e.message);
          throw e;
        }
        if (inserted && resultId) {
          newCount++;
          if (watcher.mode === "debug") {
            try {
              await this.createDebugTask(watcher, issue, resultId);
            } catch (e: any) {
              console.error(`[jira] createDebugTask error for watcher ${watcher.id}, issue ${issue.key}:`, e.message);
              // Don't fail entire poll for bot task creation errors
              updateResultStatus(resultId, "failed", { aiSummary: e.message });
            }
          } else {
            // notify-only mode
            notificationService.broadcast("done", {
              title: `Jira: ${issue.key}`,
              body: issue.fields.summary,
              project: "", sessionId: "",
            }).catch(() => {});
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

  private async createDebugTask(watcher: JiraWatcherRow, issue: JiraIssue, resultId: number): Promise<void> {
    // Look up project info from jira_config → projects
    const configRow = getDb().query(
      "SELECT c.project_id, p.name, p.path FROM jira_config c JOIN projects p ON p.id = c.project_id WHERE c.id = ?",
    ).get(watcher.jira_config_id) as { project_id: number; name: string; path: string } | null;
    if (!configRow) return;

    // Get a Telegram chat for notification
    const chat = getDb().query(
      "SELECT telegram_chat_id FROM clawbot_paired_chats WHERE status = 'approved' LIMIT 1",
    ).get() as { telegram_chat_id: string } | null;
    if (!chat) {
      // No PPMBot — just mark as pending notification
      notificationService.broadcast("done", {
        title: `Jira: ${issue.key}`,
        body: issue.fields.summary,
        project: configRow.name, sessionId: "",
      }).catch(() => {});
      return;
    }

    const prompt = this.buildPrompt(watcher, issue);
    const taskId = crypto.randomUUID();
    createBotTask(taskId, chat.telegram_chat_id, configRow.name, configRow.path, prompt, 600_000);
    updateResultStatus(resultId, "running", { sessionId: taskId });
  }

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

  // ── Sync result statuses from bot_tasks ─────────────────────────

  private startSyncLoop(): void {
    this.syncTimer = setInterval(() => this.syncResultStatuses(), 30_000);
  }

  private syncResultStatuses(): void {
    const running = getRunningResults();
    for (const result of running) {
      if (!result.session_id) continue;
      const task = getDb()
        .query("SELECT status, result_summary, session_id, error FROM bot_tasks WHERE id = ?")
        .get(result.session_id) as { status: string; result_summary: string | null; session_id: string | null; error: string | null } | null;
      if (!task) continue;

      if (task.status === "completed") {
        updateResultStatus(result.id, "done", {
          aiSummary: task.result_summary ?? undefined,
          sessionId: task.session_id ?? undefined,
        });
        notificationService.broadcast("done", {
          title: `Jira: ${result.issue_key}`,
          body: result.issue_summary ?? "Analysis complete",
          project: "",
          sessionId: task.session_id ?? "",
        }).catch(() => {});
      } else if (task.status === "failed" || task.status === "timeout") {
        updateResultStatus(result.id, "failed", {
          aiSummary: task.error ?? "Task failed",
        });
      }
    }
  }
}

export const jiraWatcherService = new JiraWatcherService();
