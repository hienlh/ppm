/**
 * The morning digest as the running server provides it: Settings, the manager table, the main
 * Assistant session, the config row, the chat door every session message goes through, the card
 * store, and the report tool's digest answers.
 */
import { getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { getMainSession } from "../assistant/assistant-main-session.ts";
import { getAssistantSettings, onAssistantSettingsSaved } from "../assistant/assistant-settings.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { assistantCards } from "../assistant-cards/assistant-cards.service.ts";
import { findOpenCardsBy } from "../assistant-cards/assistant-cards-db.ts";
import { setDigestAnswerHandler } from "../assistant-cards/manager-report-env.ts";
import { createLogger } from "../logger.ts";
import { normalizeFromSessionTitle } from "../../shared/chat-from-session.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import { createAssistantDigest, type DigestDeps } from "./assistant-digest.service.ts";
import { digestStateRow } from "./digest-state.ts";

const log = createLogger("assistant-digest");

/** What every manager chat is asked: fixed PPM text, never anything a model wrote. */
export const DIGEST_ASK_TEXT = "Morning digest. When you are free, call `report_to_assistant` with kind `digest` and at most 12 short "
  + "items: what is waiting on the user, what is running, what finished since the last digest. Do not start other work for this.";

/** PPM asked on its own, and nothing anyone else wrote is in the ask. */
const ASK_PROVENANCE: AssistantProvenance = { startedBy: "ppm", untrusted: false, reason: "morning_digest" };

export const digestDeps: DigestDeps = {
  clock: assistantClock,
  settings: () => {
    const s = getAssistantSettings();
    return { digest: s.digest, ...(s.timezone ? { zone: s.timezone } : {}) };
  },
  managers: () => managerChats.list().map((m) => ({
    projectKey: m.projectKey, projectName: m.projectName, projectPath: m.projectPath, sessionId: m.sessionId,
    providerId: m.providerId, digest: m.digest, titleOnly: m.telegramDetail === "title",
  })),
  mainSession: () => getMainSession()?.sessionId ?? null,
  state: digestStateRow,
  deliverAsk: async (manager, from) => {
    const { deliverToSession } = await import("../../server/ws/chat-inject.ts");
    const out = await deliverToSession({
      targetSessionId: manager.sessionId, providerId: manager.providerId,
      projectName: manager.projectName, projectPath: manager.projectPath,
      body: DIGEST_ASK_TEXT,
      fromSession: {
        version: 1, sessionId: from, providerId: "claude", projectName: ASSISTANT_PROJECT_NAME, kind: "assistant",
        title: normalizeFromSessionTitle(getSessionTitle(from) ?? "PPM Assistant"), sentAt: new Date(assistantClock.now()).toISOString(),
      },
      // Waits for a running manager turn to end rather than joining it.
      priority: "later",
      provenance: ASK_PROVENANCE,
    });
    return { clientMessageId: out.clientMessageId, started: out.delivered === "started" || !!out.turnBinding };
  },
  onTurnBound: (listener) => {
    let off: (() => void) | null = null;
    let gone = false;
    void import("../../server/ws/chat.ts").then(({ onTurnBinding }) => {
      if (gone) return;
      off = onTurnBinding((b) => { if (b.clientMessageId) listener(b.clientMessageId); });
    }).catch((e) => log.warn(`turn bindings unavailable: ${(e as Error).message}`));
    return () => { gone = true; off?.(); };
  },
  existingCard: (date) => findOpenCardsBy("digest", "date", date)[0]?.id ?? null,
  createCard: (card) => assistantCards.create(card),
  canonical: resolveMigratedSession,
};

/** The process-wide digest. */
export const assistantDigest = createAssistantDigest(digestDeps);

let stops: Array<() => void> = [];

/** Starts the digest's timer and finishes what a restart left; answers reach it from the report tool. */
export function startAssistantDigest(): Promise<void> {
  if (stops.length === 0) {
    setDigestAnswerHandler((sessionId, items) => assistantDigest.answer(sessionId, items));
    stops = [onAssistantSettingsSaved(() => assistantDigest.rearm()), () => setDigestAnswerHandler(null)];
  }
  return assistantDigest.start();
}

export function stopAssistantDigest(): void {
  for (const stop of stops.splice(0)) stop();
  assistantDigest.stop();
}
