/**
 * The send budget PPM's own "wake the manager" turns are charged to: the same hourly, daily and
 * per-manager limits as PPM Assistant's unattended messages to manager chats
 * (`assistant-send-guards.ts`), counted under one sender, `ppm-tasks`. Quiet hours do not hold
 * these: a wake the user asked for is sent because the user is there, and a check finding is
 * handled while the phone card waits. The state survives a restart in its own config row; the
 * user writing in a manager chat restarts that pair's count and lifts a pause.
 */
import { configService } from "../config.service.ts";
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { resolveSessionCollabSettings } from "../../shared/session-collab-settings.ts";
import { createAssistantSendGuards } from "../session-collab/assistant-send-guards.ts";

export const PPM_TASKS_WAKE_SENDER = "ppm-tasks";
export const PPM_TASKS_WAKE_BUDGET_ROW = "ppm_tasks_wake_budget_state";

export type WakeReservation = { ok: true; release(): void } | { ok: false; message: string };

let guards: ReturnType<typeof createAssistantSendGuards> | null = null;
const live = () => (guards ??= createAssistantSendGuards({
  now: () => Date.now(),
  quiet: () => false,
  load: () => getConfigValue(PPM_TASKS_WAKE_BUDGET_ROW),
  save: (json) => setConfigValue(PPM_TASKS_WAKE_BUDGET_ROW, json),
}));

/** Counts one wake of `managerSessionId`, or says why it may not go. */
export function reserveManagerWake(managerSessionId: string): WakeReservation {
  const pairLimit = resolveSessionCollabSettings(configService.get("ai").session_collab).maxAutoMessagesPerPair;
  const reserved = live().reserveUnattended(PPM_TASKS_WAKE_SENDER, managerSessionId, pairLimit);
  return reserved.ok ? reserved : { ok: false, message: reserved.message };
}

chatLifecycle.on("user_message", (m) => {
  if (m.traceOrigin || (m.origin !== "ws" && m.origin !== "telegram")) return;
  // Only a project's manager chat is ever woken, but which chats are managers is not known here
  // without a lookup per message: resetting a pair that does not exist costs nothing.
  try {
    live().userWrote(m.sessionId);
    live().userWrote(PPM_TASKS_WAKE_SENDER);
  } catch { /* no database in this process: nothing to lift */ }
});
