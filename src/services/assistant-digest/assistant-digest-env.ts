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
import { configService } from "../config.service.ts";
import { ppmToolOn } from "../../shared/ppm-tools.ts";
import { REPORT_WITHDRAW_TOOL } from "../../shared/card-withdraw.ts";
import { normalizeFromSessionTitle } from "../../shared/chat-from-session.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import { createAssistantDigest, type DigestDeps } from "./assistant-digest.service.ts";
import { digestStateRow } from "./digest-state.ts";
import { digestWaiting } from "./digest-waiting-tasks.ts";
import { listTasks } from "../ppm-tasks/ppm-tasks.service.ts";
import { memberRows, statusRows } from "../ppm-tasks/ppm-tasks-db.ts";
import { todayYmd } from "../ppm-tasks/ppm-tasks-today.ts";
import { getTaskProject } from "../ppm-tasks/ppm-tasks-projects.service.ts";
import { projectNameForPath } from "../project-name-for-path.ts";
import { basename } from "node:path";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { digestResurfacedTasks } from "./digest-resurfaced-tasks.ts";
import { digestVoiceLearned } from "./digest-voice-learned.ts";

const log = createLogger("assistant-digest");

/** What every manager chat is asked: fixed PPM text, never anything a model wrote. */
export const DIGEST_ASK_TEXT = "Morning digest. When you are free, call `report_to_assistant` with kind `digest` and at most 12 short "
  + "`items`, one line each (the card shows only `items`, so leave `body` out): what is waiting on the user, what is "
  + "running, what finished since the last digest. Do not start other work for this.";

/**
 * Added to the ask while the user has card withdrawal on: fixed text too, so the manager looks up
 * its own open cards with the tool rather than PPM pasting their titles (a model's words) in here.
 */
export const DIGEST_ASK_WITHDRAW_TEXT = "Also call `report_withdraw` with no `cards` to see your cards still waiting on the "
  + "user, and withdraw the ones a newer card replaced or the user already handled (with a reason). Keep every card the "
  + "user may still answer, however old.";

/** The digest ask, with the withdrawal reminder when card withdrawal is on. */
export function digestAskText(withdrawOn: boolean): string {
  return withdrawOn ? `${DIGEST_ASK_TEXT} ${DIGEST_ASK_WITHDRAW_TEXT}` : DIGEST_ASK_TEXT;
}

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
      body: digestAskText(ppmToolOn(configService.get("ai") ?? {}, REPORT_WITHDRAW_TOOL)),
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
  waitingTasks: (projectKey) => {
    const path = getTaskProject(projectKey)?.projectPath ?? projectKey;
    const name = projectNameForPath(path) ?? basename(path);
    const members = new Map(memberRows(projectKey).map((m) => [m.id, m.name]));
    const statuses = new Map(statusRows(projectKey).map((s) => [s.id, s.name]));
    const now = assistantClock.now();
    const today = todayYmd(now);
    return digestWaiting(listTasks({ projectKeys: [projectKey] }, today), {
      ref: (t) => formatTaskRef(t.number, name), nameOf: (_t, id) => members.get(id) ?? null, statusName: (t) => statuses.get(t.statusId) ?? null, today, now,
    });
  },
  resurfaced: digestResurfacedTasks,
  voiceLearned: (date) => digestVoiceLearned(date, assistantClock.now()),
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
