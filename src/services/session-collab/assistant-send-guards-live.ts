/**
 * The running server's guards for PPM Assistant → manager chat messages: the budget state in the
 * `assistant_budget_state` config row (outside the settings rows, so no settings save resets it),
 * quiet hours from Settings → PPM Assistant, the shared Assistant clock, and the user's own
 * messages — in PPM or on Telegram, never a scheduled script's — as what restarts the pair counts
 * and lifts a pause.
 */
import { getConfigValue, resolveMigratedSession, setConfigValue } from "../db.service.ts";
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { assistantBudgetEvents } from "../assistant/assistant-budget-events.ts";
import { inQuietHours } from "../../shared/assistant-quiet-hours.ts";
import { assistantWakeQueue, type AssistantWakeQueue } from "../assistant-wake/assistant-wake-queue.ts";
import { cutOffChatsCarried, RESTART_SOURCE_NAME } from "../restart-news/restart-news-source.ts";
import { createAssistantSendGuards } from "./assistant-send-guards.ts";

export const ASSISTANT_BUDGET_STATE_ROW = "assistant_budget_state";

/** The project of a manager chat, by its session id; null when it is no manager. */
const managerProject = (manager: string): string | null => {
  const id = resolveMigratedSession(manager);
  return managerChats.list().find((r) => resolveMigratedSession(r.sessionId) === id)?.projectName ?? null;
};

/**
 * Whether quiet hours hold back this Assistant session's unattended message to `manager`. A restart
 * that cut chats off mid-turn is urgent: the turn telling of it was let through quiet hours to get
 * that work resumed, so its messages to the managers of projects with cut-off chats are too — and
 * only those; any other message of that turn waits like the rest. Budgets still apply.
 */
export function assistantQuietNow(
  assistant: string,
  manager: string,
  queue: Pick<AssistantWakeQueue, "carryingUrgent" | "carriedItems"> = assistantWakeQueue,
  projectOf: (manager: string) => string | null = managerProject,
): boolean {
  if (queue.carryingUrgent(assistant, RESTART_SOURCE_NAME)) {
    const project = projectOf(manager);
    if (project && cutOffChatsCarried(queue, assistant, project).length > 0) return false;
  }
  const settings = getAssistantSettings();
  return inQuietHours(assistantClock.now(), settings.quiet_hours, settings.timezone);
}

export const assistantSendGuards = createAssistantSendGuards({
  now: () => assistantClock.now(),
  quiet: (assistant, manager) => assistantQuietNow(assistant, manager),
  load: () => getConfigValue(ASSISTANT_BUDGET_STATE_ROW),
  save: (json) => setConfigValue(ASSISTANT_BUDGET_STATE_ROW, json),
  announce: (event) => assistantBudgetEvents.emit({ ...event, at: assistantClock.now() }),
});

chatLifecycle.on("user_message", (m) => {
  if (m.traceOrigin || (m.origin !== "ws" && m.origin !== "telegram")) return;
  assistantSendGuards.userWrote(m.sessionId);
});
