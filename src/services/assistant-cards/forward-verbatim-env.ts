/**
 * What forwarding the user's words needs from the running server: the card's manager chat as it
 * is now, the delivery door in the chat socket layer (loaded on first use, which keeps this
 * service free of an import cycle), the main Assistant session, the pair counters and the trace.
 */
import { configService } from "../config.service.ts";
import { getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import { projectKey } from "../project-name-for-path.ts";
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { getMainSession } from "../assistant/assistant-main-session.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { pairCounter } from "../session-collab/pair-counter.ts";
import { assistantSendGuards } from "../session-collab/assistant-send-guards-live.ts";
import { traceServerEvent } from "../session-trace/trace-recorder.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { noteCardAnswered } from "./card-answer-notes.ts";
import type { ForwardEnv, ForwardTarget } from "./forward-verbatim.ts";

function mainSessionId(): string | null {
  try {
    return getMainSession()?.sessionId ?? null;
  } catch {
    return null;
  }
}

/** The chat a card came from, with its project as PPM lists it now; null when either is gone. */
export function managerTargetOf(card: AssistantCard): ForwardTarget | null {
  if (!card.sessionId || !card.projectKey) return null;
  const sessionId = resolveMigratedSession(card.sessionId);
  const project = configService.get("projects").find((p) => projectKey(p.path) === card.projectKey);
  const row = managerChats.list().find((r) => r.projectKey === card.projectKey);
  const projectPath = project?.path ?? row?.projectPath;
  if (!projectPath) return null;
  return {
    sessionId,
    providerId: getSessionProvider(sessionId) ?? row?.providerId ?? "claude",
    projectName: project?.name ?? card.projectName ?? "project",
    projectPath,
  };
}

export const realForwardEnv: ForwardEnv = {
  now: () => assistantClock.now(),
  managerTarget: managerTargetOf,
  deliverUserWords: async (input) => (await import("../../server/ws/chat-user-words.ts")).deliverUserWords(input),
  async sendToAssistant(text) {
    const main = mainSessionId();
    const control = chatControl();
    if (!main || !control) return { ok: false, error: "There is no main Assistant session to send it to." };
    const result = await control.sendUserMessage(main, text, {
      origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: getSessionProvider(main) ?? "claude",
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  },
  userWrote(sessionId) {
    pairCounter.resetForSession(sessionId);
    assistantSendGuards.userWrote(sessionId);
  },
  mainSession: mainSessionId,
  note: noteCardAnswered,
  trace: (sessionId, providerId, payload) => traceServerEvent(sessionId, providerId, "user_words_forwarded", payload),
};
