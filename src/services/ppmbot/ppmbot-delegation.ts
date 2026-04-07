import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import { getBotTask, updateBotTaskStatus } from "../db.service.ts";
import { escapeHtml } from "./ppmbot-formatter.ts";
import type { PPMBotTelegram } from "./ppmbot-telegram.ts";
import type { ChatEvent } from "../../types/chat.ts";
import type { PermissionMode } from "../../types/config.ts";

/** Active background tasks: taskId -> AbortController */
const activeTasks = new Map<string, AbortController>();

export async function executeDelegation(
  taskId: string,
  telegram: PPMBotTelegram,
  providerId: string,
): Promise<void> {
  const task = getBotTask(taskId);
  if (!task || task.status !== "pending") return;

  // Guard against double-execution
  if (activeTasks.has(taskId)) return;

  const abort = new AbortController();
  activeTasks.set(taskId, abort);

  updateBotTaskStatus(taskId, "running");

  const timer = setTimeout(() => {
    abort.abort();
    activeTasks.delete(taskId);
    updateBotTaskStatus(taskId, "timeout");
    telegram.sendMessage(
      Number(task.chatId),
      `⏱ Task timed out: <i>${escapeHtml(task.prompt.slice(0, 80))}</i>`,
    );
  }, task.timeoutMs);

  try {
    const session = await chatService.createSession(providerId, {
      projectPath: task.projectPath,
      projectName: task.projectName,
      title: `[PPMBot] ${task.prompt.slice(0, 50)}`,
    });

    const opts = { permissionMode: "bypassPermissions" as PermissionMode };
    const events = chatService.sendMessage(providerId, session.id, task.prompt, opts);

    let fullText = "";
    let lastAssistantText = "";

    for await (const event of events) {
      if (abort.signal.aborted) break;

      if (event.type === "text") {
        lastAssistantText = event.content;
        fullText += event.content;
      }
      if (event.type === "done" && event.resultSubtype === "success") {
        // done event — session finished
      }
    }

    clearTimeout(timer);
    activeTasks.delete(taskId);

    if (abort.signal.aborted) return;

    const summary = lastAssistantText.slice(0, 500) || "Task completed (no text output)";

    updateBotTaskStatus(taskId, "completed", {
      sessionId: session.id,
      resultSummary: summary,
      resultFull: fullText.trim(),
    });

    await telegram.sendMessage(
      Number(task.chatId),
      `✅ <b>${escapeHtml(task.projectName)}</b> task done\n\n` +
        `<i>${escapeHtml(task.prompt.slice(0, 80))}</i>\n\n` +
        `${escapeHtml(summary.slice(0, 300))}` +
        (summary.length > 300 ? "…" : ""),
    );
  } catch (err) {
    clearTimeout(timer);
    activeTasks.delete(taskId);

    if (abort.signal.aborted) return;

    const errorMsg = err instanceof Error ? err.message : String(err);
    updateBotTaskStatus(taskId, "failed", { error: errorMsg });

    await telegram.sendMessage(
      Number(task.chatId),
      `❌ Task failed (<b>${escapeHtml(task.projectName)}</b>)\n\n` +
        `<i>${escapeHtml(task.prompt.slice(0, 80))}</i>\n\n` +
        `Error: ${escapeHtml(errorMsg.slice(0, 200))}`,
    );
  }
}

export function cancelDelegation(taskId: string): boolean {
  const abort = activeTasks.get(taskId);
  if (!abort) return false;
  abort.abort();
  activeTasks.delete(taskId);
  updateBotTaskStatus(taskId, "failed", { error: "Cancelled by user" });
  return true;
}

export function getActiveDelegationCount(): number {
  return activeTasks.size;
}
