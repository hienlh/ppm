import { chatService } from "./chat.service.ts";
import { getDb } from "./db.service.ts";
import { updateResultStatus, getResultById } from "./jira-watcher-db.service.ts";
import { notificationService } from "./notification.service.ts";
import { forwardEventToSession } from "../server/ws/chat.ts";
import type { JiraWatcherRow } from "../types/jira.ts";
import type { PermissionMode } from "../types/config.ts";

const MAX_CONCURRENT = 2;
const MAX_PER_PROJECT = 1;

interface QueueItem {
  resultId: number;
  prompt?: string;
  resume?: boolean; // reuse existing session instead of creating new
}

class JiraDebugSessionService {
  private queue: QueueItem[] = [];
  private active = new Map<number, AbortController>(); // resultId → abort
  private activeByProject = new Map<string, number>(); // projectPath → count
  private enqueuedIds = new Set<number>(); // guard against double-enqueue

  /** Reset zombie results from previous server run (running/queued with no active process) */
  init(): void {
    const zombies = getDb().query(
      `UPDATE jira_watch_results SET status = 'failed', ai_summary = 'Server restarted during debug'
       WHERE status IN ('running', 'queued') AND deleted = 0 RETURNING id, issue_key`,
    ).all() as { id: number; issue_key: string }[];
    if (zombies.length > 0) {
      console.log(`[jira-debug] Reset ${zombies.length} zombie results: ${zombies.map((z) => z.issue_key).join(", ")}`);
    }
  }

  /** Enqueue a result for debug. Accepts "pending" or "failed" (retry). */
  enqueue(resultId: number, promptOverride?: string): void {
    if (this.enqueuedIds.has(resultId)) return; // prevent double-enqueue
    const result = getResultById(resultId);
    if (!result) throw new Error("Result not found");
    if (result.status !== "pending" && result.status !== "failed") {
      throw new Error(`Result status is "${result.status}", expected "pending" or "failed"`);
    }

    this.enqueuedIds.add(resultId);
    updateResultStatus(resultId, "queued");
    this.broadcastStatusChange(resultId, result.issueKey, "queued");
    this.queue.push({ resultId, prompt: promptOverride });
    this.processQueue();
  }

  /** Resume a failed session that already has a sessionId */
  resumeDebug(resultId: number, prompt?: string): void {
    if (this.enqueuedIds.has(resultId)) return;
    const result = getResultById(resultId);
    if (!result) throw new Error("Result not found");
    if (result.status !== "failed") throw new Error("Only failed results can be resumed");
    if (!result.sessionId) throw new Error("No session to resume — use debug instead");

    this.enqueuedIds.add(resultId);
    updateResultStatus(resultId, "queued");
    this.broadcastStatusChange(resultId, result.issueKey, "queued");
    this.queue.push({
      resultId,
      prompt: prompt ?? "Continue debugging. The previous session was interrupted before completing.",
      resume: true,
    });
    this.processQueue();
  }

  /** Cancel a running or queued debug session */
  cancelDebug(resultId: number): boolean {
    // Remove from queue if still queued
    const qIdx = this.queue.findIndex((q) => q.resultId === resultId);
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1);
      this.enqueuedIds.delete(resultId);
      const result = getResultById(resultId);
      updateResultStatus(resultId, "failed", { aiSummary: "Cancelled by user" });
      if (result) this.broadcastStatusChange(resultId, result.issueKey, "failed");
      return true;
    }
    // Abort if actively running
    const abort = this.active.get(resultId);
    if (!abort) return false;
    abort.abort();
    const result = getResultById(resultId);
    updateResultStatus(resultId, "failed", { aiSummary: "Cancelled by user" });
    if (result) this.broadcastStatusChange(resultId, result.issueKey, "failed");
    return true;
  }

  // [H2 fix] Iterate through queue to avoid head-of-line blocking
  private processQueue(): void {
    let i = 0;
    while (i < this.queue.length && this.active.size < MAX_CONCURRENT) {
      const item = this.queue[i]!;
      const project = this.resolveProjectInfo(item.resultId);
      if (!project) { this.queue.splice(i, 1); continue; }

      const projectCount = this.activeByProject.get(project.path) ?? 0;
      if (projectCount >= MAX_PER_PROJECT) { i++; continue; }

      this.queue.splice(i, 1);
      this.runDebugSession(item.resultId, item.prompt, project, item.resume).catch((e) => {
        console.error(`[jira-debug] session error resultId=${item.resultId}:`, e.message);
      });
    }
  }

  // [H3 fix] Single method for project lookup — used by both processQueue and runDebugSession
  private resolveProjectInfo(resultId: number): { path: string; name: string } | null {
    return getDb().query(`
      SELECT p.path, p.name FROM jira_watch_results r
      JOIN jira_watchers w ON w.id = r.watcher_id
      JOIN jira_config c ON c.id = w.jira_config_id
      JOIN projects p ON p.id = c.project_id
      WHERE r.id = ?
    `).get(resultId) as { path: string; name: string } | null;
  }

  private resolveWatcherForResult(resultId: number): JiraWatcherRow | null {
    return getDb().query(`
      SELECT w.* FROM jira_watch_results r
      JOIN jira_watchers w ON w.id = r.watcher_id
      WHERE r.id = ?
    `).get(resultId) as JiraWatcherRow | null;
  }

  private async runDebugSession(
    resultId: number, promptOverride: string | undefined,
    project: { path: string; name: string },
    resume?: boolean,
  ): Promise<void> {
    const result = getResultById(resultId);
    if (!result) return;

    // Build prompt
    let prompt: string;
    if (promptOverride) {
      prompt = promptOverride;
    } else {
      const watcher = this.resolveWatcherForResult(resultId);
      if (watcher?.prompt_template) {
        prompt = watcher.prompt_template
          .replace(/\{issue_key\}/g, result.issueKey)
          .replace(/\{summary\}/g, result.issueSummary ?? "")
          .replace(/\{description\}/g, "(fetched from Jira)")
          .replace(/\{status\}/g, "")
          .replace(/\{priority\}/g, "");
      } else {
        prompt = `Debug Jira issue ${result.issueKey}: ${result.issueSummary ?? "No summary"}`;
      }
    }

    // Track concurrency
    const abort = new AbortController();
    this.active.set(resultId, abort);
    this.activeByProject.set(project.path, (this.activeByProject.get(project.path) ?? 0) + 1);

    updateResultStatus(resultId, "running");
    this.broadcastStatusChange(resultId, result.issueKey, "running");

    try {
      // Resume: reuse existing session (SDK can resume from disk even after restart)
      let session: { id: string; providerId: string };
      if (resume && result.sessionId) {
        // SDK provider's sendMessage auto-resumes sessions from disk via resumeSession()
        // We just need the sessionId and the correct providerId
        const existing = chatService.getSession(result.sessionId);
        session = existing
          ? { id: existing.id, providerId: existing.providerId }
          : { id: result.sessionId, providerId: "claude" }; // default provider
      } else {
        session = await chatService.createSession(undefined, {
          projectPath: project.path,
          projectName: project.name,
          title: `[Jira Debug] ${result.issueKey}: ${(result.issueSummary ?? "").slice(0, 50)}`,
        });
      }

      // Persist sessionId immediately so UI can show "Open" button while running
      updateResultStatus(resultId, "running", { sessionId: session.id });
      this.broadcastStatusChange(resultId, result.issueKey, "running", session.id);

      // bypassPermissions: automated debug sessions run without user approval (same as PPMBot)
      const opts = { permissionMode: "bypassPermissions" as PermissionMode };
      const events = chatService.sendMessage(session.providerId, session.id, prompt, opts);

      let lastAssistantText = "";
      for await (const event of events) {
        if (abort.signal.aborted) break;
        if (event.type === "text") lastAssistantText = event.content;
        // Forward events to any connected WS client viewing this session
        forwardEventToSession(session.id, event);
      }

      if (abort.signal.aborted) return;

      const aiSummary = lastAssistantText.slice(0, 500) || "Debug session completed (no text output)";
      updateResultStatus(resultId, "done", { sessionId: session.id, aiSummary });

      // Broadcast WS event + notification
      this.broadcastStatusChange(resultId, result.issueKey, "done", session.id);

      notificationService.broadcast("done", {
        title: `Jira: ${result.issueKey}`,
        body: aiSummary.slice(0, 200),
        project: project.name,
        sessionId: session.id,
      }).catch(() => {});
    } catch (e: any) {
      if (!abort.signal.aborted) {
        updateResultStatus(resultId, "failed", { aiSummary: e.message?.slice(0, 300) ?? "Unknown error" });
        this.broadcastStatusChange(resultId, result.issueKey, "failed");
      }
    } finally {
      this.cleanup(resultId, project.path);
      this.processQueue();
    }
  }

  private broadcastStatusChange(resultId: number, issueKey: string, status: string, sessionId?: string): void {
    notificationService.broadcastWs({
      type: "jira:status_change",
      resultId, issueKey, status, sessionId,
    }).catch(() => {});
  }

  // [C1 fix] Idempotent cleanup — safe to call multiple times
  private cleanup(resultId: number, projectPath: string): void {
    if (!this.active.has(resultId)) return; // already cleaned up
    this.active.delete(resultId);
    this.enqueuedIds.delete(resultId);
    const count = (this.activeByProject.get(projectPath) ?? 1) - 1;
    if (count <= 0) this.activeByProject.delete(projectPath);
    else this.activeByProject.set(projectPath, count);
  }
}

export const jiraDebugService = new JiraDebugSessionService();
