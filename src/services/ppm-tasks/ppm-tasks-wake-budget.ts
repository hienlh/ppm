/**
 * The send budget PPM's own "wake the manager" turns are charged to: the same hourly, daily and
 * per-manager limits as PPM Assistant's unattended messages to manager chats
 * (`assistant-send-guards.ts`), counted under one sender, `ppm-tasks`. Quiet hours do not hold
 * these: a wake the user asked for is sent because the user is there, and a check finding is
 * handled while the phone card waits. Each project counts under its own sender
 * (`ppm-tasks:<project key>`), so one busy project never pauses another's wakes. The state survives a
 * restart in its own config row; the user writing in a project's manager chat, or asking for a
 * wake themselves, restarts that project's count and lifts its pause.
 */
import { configService } from "../config.service.ts";
import { getConfigValue, getDb, resolveMigratedSession, setConfigValue } from "../db.service.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { resolveSessionCollabSettings } from "../../shared/session-collab-settings.ts";
import { createAssistantSendGuards } from "../session-collab/assistant-send-guards.ts";

/** The budget sender of one project. */
export const wakeSender = (projectKey: string): string => `ppm-tasks:${projectKey}`;
export const PPM_TASKS_WAKE_BUDGET_ROW = "ppm_tasks_wake_budget_state";

export type WakeReservation = { ok: true; release(): void } | { ok: false; message: string };

let guards: ReturnType<typeof createAssistantSendGuards> | null = null;
const live = () => (guards ??= createAssistantSendGuards({
  now: () => Date.now(),
  quiet: () => false,
  load: () => getConfigValue(PPM_TASKS_WAKE_BUDGET_ROW),
  save: (json) => setConfigValue(PPM_TASKS_WAKE_BUDGET_ROW, json),
}));

/** Restarts a project's count and lifts its pause: the user is here. */
function userPresent(projectKey: string, managerSessionId: string): void {
  live().userWrote(managerSessionId);
  live().userWrote(wakeSender(projectKey));
}

/**
 * Counts one wake of the project's manager, or says why it may not go. A wake the user asked for
 * (`byUser`) first lifts the project's pause, as the user typing would.
 */
export function reserveManagerWake(managerSessionId: string, projectKey: string, byUser: boolean): WakeReservation {
  if (byUser) userPresent(projectKey, managerSessionId);
  const pairLimit = resolveSessionCollabSettings(configService.get("ai").session_collab).maxAutoMessagesPerPair;
  const reserved = live().reserveUnattended(wakeSender(projectKey), managerSessionId, pairLimit);
  return reserved.ok ? reserved : { ok: false, message: reserved.message };
}

/** The project a manager chat manages, or null. */
function managedProject(sessionId: string): string | null {
  const id = resolveMigratedSession(sessionId);
  const rows = getDb().query("SELECT project_key, session_id FROM manager_chats").all() as Array<{ project_key: string; session_id: string }>;
  return rows.find((r) => resolveMigratedSession(r.session_id) === id)?.project_key ?? null;
}

chatLifecycle.on("user_message", (m) => {
  if (m.traceOrigin || (m.origin !== "ws" && m.origin !== "telegram")) return;
  try {
    const project = managedProject(m.sessionId);
    if (project) userPresent(project, m.sessionId);
  } catch { /* no database in this process: nothing to lift */ }
});
