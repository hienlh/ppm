/**
 * What every surface listing manager chats is told: `GET /api/assistant/managers` answers with
 * {@link managerSummaries}, and every change is announced on `/ws/global` as
 * `assistant:managers_changed`, followed by `sessions:list_changed` for each project it touched so
 * that project's session list re-sorts and moves the badge.
 */
import { getSessionTitle } from "../db.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { chatTargetMode, collabLiveState } from "../../server/ws/chat.ts";
import { MANAGERS_CHANGED_EVENT, type ManagerChatSummary } from "../../shared/assistant-managers.ts";
import { createLogger } from "../logger.ts";
import { managerChats } from "./manager-chats.service.ts";

const log = createLogger("assistant-managers");

type SessionInfoById = { getSessionInfoById?: (id: string, dir?: string) => Promise<{ title?: string } | null> };

/** PPM's own title for the chat, else the provider's. Null when neither has one yet. */
export async function managerChatTitle(sessionId: string, providerId: string, projectPath: string): Promise<string | null> {
  const own = getSessionTitle(sessionId);
  if (own) return own;
  const provider = providerRegistry.get(providerId) as unknown as SessionInfoById | undefined;
  try {
    const info = await provider?.getSessionInfoById?.(sessionId, projectPath);
    return info?.title || null;
  } catch {
    return null;
  }
}

/** Every project's manager, with what the chat is doing now. */
export async function managerSummaries(): Promise<ManagerChatSummary[]> {
  const { assistantCards } = await import("../assistant-cards/assistant-cards.service.ts");
  let waiting: Record<string, number> = {};
  try {
    waiting = assistantCards.waiting().byProject;
  } catch (e) {
    log.warn(`Could not count the cards waiting per project: ${(e as Error).message}`);
  }
  return Promise.all(managerChats.list().map(async (row) => {
    const live = collabLiveState(row.sessionId);
    return {
      projectName: row.projectName,
      projectPath: row.projectPath,
      sessionId: row.sessionId,
      providerId: row.providerId,
      title: await managerChatTitle(row.sessionId, row.providerId, row.projectPath),
      phase: live?.phase ?? "idle",
      permissionMode: chatTargetMode(row.sessionId, row.providerId).mode,
      digest: row.digest,
      telegramDetail: row.telegramDetail,
      waiting: waiting[row.projectName] ?? 0,
      rulesPending: row.rulesPendingHash !== null,
    };
  }));
}

export async function announceManagersChanged(projectNames: string[]): Promise<void> {
  try {
    broadcastGlobalEvent({ type: MANAGERS_CHANGED_EVENT, managers: await managerSummaries() });
  } catch (e) {
    log.warn(`Could not announce the manager chats: ${(e as Error).message}`);
  }
  for (const projectName of new Set(projectNames)) {
    if (projectName) broadcastGlobalEvent({ type: "sessions:list_changed", projectName });
  }
}
