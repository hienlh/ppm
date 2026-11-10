/**
 * The running server's guards for PPM Assistant → manager chat messages: the budget state in the
 * `assistant_budget_state` config row (outside the settings rows, so no settings save resets it),
 * quiet hours from Settings → PPM Assistant, the shared Assistant clock, and the user's own
 * messages — in PPM or on Telegram, never a scheduled script's — as what restarts the pair counts
 * and lifts a pause.
 */
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { assistantBudgetEvents } from "../assistant/assistant-budget-events.ts";
import { inQuietHours } from "../../shared/assistant-quiet-hours.ts";
import { createAssistantSendGuards } from "./assistant-send-guards.ts";

export const ASSISTANT_BUDGET_STATE_ROW = "assistant_budget_state";

export const assistantSendGuards = createAssistantSendGuards({
  now: () => assistantClock.now(),
  quiet: () => {
    const settings = getAssistantSettings();
    return inQuietHours(assistantClock.now(), settings.quiet_hours, settings.timezone);
  },
  load: () => getConfigValue(ASSISTANT_BUDGET_STATE_ROW),
  save: (json) => setConfigValue(ASSISTANT_BUDGET_STATE_ROW, json),
  announce: (event) => assistantBudgetEvents.emit({ ...event, at: assistantClock.now() }),
});

chatLifecycle.on("user_message", (m) => {
  if (m.traceOrigin || (m.origin !== "ws" && m.origin !== "telegram")) return;
  assistantSendGuards.userWrote(m.sessionId);
});
