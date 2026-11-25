/**
 * `report_to_assistant` as the running server provides it: the card store, the shared clock,
 * quiet hours from Settings, and the morning digest's answers (refused while the digest is not
 * running).
 */
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { currentQuietWindowStart } from "../assistant-wake/wake-quiet-hours.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { assistantCards } from "./assistant-cards.service.ts";
import { countSessionCardsSince, findOpenChatMirrorCard, findOpenSessionCardsWithText, findOpenUrgentTitled } from "./assistant-cards-db.ts";
import { getDb, resolveMigratedSession } from "../db.service.ts";
import { parseTaskRef, formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { withdrawCards } from "./card-withdraw.ts";
import { cardWithdrawOn, liveWithdrawEnv, openCardsOfManager } from "./card-withdraw-env.ts";
import { DIGEST_NOT_ASKED, fileReport, sameReport, type ReportEnv } from "./manager-report-tool.ts";
import { createLogger } from "../logger.ts";
import { readShotSync } from "../design/shots/design-shots.service.ts";
import { projectKey } from "../project-name-for-path.ts";

/** Refused for every chat but a project's current manager chat. */
export const NOT_A_MANAGER = "Only a project's manager chat can report to PPM Assistant. Answer the user in this chat instead.";

type DigestAnswerHandler = ReportEnv["digestAnswer"];
const log = createLogger("assistant-cards");

const NO_DIGEST: DigestAnswerHandler = () => ({ ok: false, message: DIGEST_NOT_ASKED });
let digestAnswers: DigestAnswerHandler = NO_DIGEST;

/** The morning digest takes the digest answers while it runs; null puts the refusal back. */
export function setDigestAnswerHandler(handler: DigestAnswerHandler | null): void {
  digestAnswers = handler ?? NO_DIGEST;
}

export const reportEnv: ReportEnv = {
  now: () => assistantClock.now(),
  countSince: (sessionId, kinds, since) => countSessionCardsSince([sessionId], kinds, since),
  openUrgentTitled: (sessionId, title, since) => {
    const row = findOpenUrgentTitled(sessionId, title, since);
    return row ? assistantCards.toCard(row) : null;
  },
  openIdentical: (sessionId, card) => {
    for (const row of findOpenSessionCardsWithText(sessionId, card.kind, card.title, card.body ?? "")) {
      const open = assistantCards.toCard(row);
      if (sameReport(open, card)) return open;
    }
    return null;
  },
  // A chat named by the id it had when its card was shown, or by the one it goes by now (Codex
  // renames a new chat during its first turn).
  waitingChatCard: (projectPath, chatSessionId) => {
    const ids = [...new Set([chatSessionId, resolveMigratedSession(chatSessionId)])];
    const row = findOpenChatMirrorCard(ids, projectKey(projectPath));
    return row ? assistantCards.toCard(row) : null;
  },
  shotOf: (id, projectPath) => {
    const shot = readShotSync(id);
    if (!shot || projectKey(shot.projectPath) !== projectKey(projectPath)) return null;
    return { id: shot.id, designTitle: shot.designTitle, file: shot.file, label: shot.label };
  },
  quietWindowStart: currentQuietWindowStart,
  digestAnswer: (sessionId, items) => digestAnswers(sessionId, items),
  create: (card) => assistantCards.create(card),
  withdrawOn: cardWithdrawOn,
  resolveTask: (projectPath, raw) => resolveProjectTask(projectPath, raw),
  withdraw: (caller, refs, reason, by, dryRun) =>
    withdrawCards(liveWithdrawEnv, { kind: "manager", sessionId: caller.sessionId, projectKey: projectKey(caller.projectPath) }, refs, reason, by, dryRun),
  markSupersedes: (cardId, replaced) => {
    const known = assistantCards.get(cardId)?.payload.supersedes ?? [];
    const merged = [...known, ...replaced.filter((r) => !known.some((k) => k.id === r.id))];
    assistantCards.patchPayload(cardId, { supersedes: merged }, "changed");
  },
  openOwnCards: (caller, except) =>
    openCardsOfManager({ kind: "manager", sessionId: caller.sessionId, projectKey: projectKey(caller.projectPath) }, except),
};

/**
 * A task of this project named the way people write it (`ppm/76`, `#76`, `76`): a project named in
 * the reference must be this one, since a manager reports only about its own project.
 */
export function resolveProjectTask(projectPath: string, raw: string): { taskId: string; ref: string; title: string } | { error: string } {
  const parsed = parseTaskRef(raw);
  if (!parsed) return { error: `"${raw.slice(0, 60)}" is not a task reference: use ppm/76 or #76.` };
  const key = projectKey(projectPath);
  const row = getDb().query("SELECT id, number, title FROM tasks WHERE project_key = ? AND number = ? AND deleted_at IS NULL")
    .get(key, parsed.number) as { id: string; number: number; title: string } | null;
  const projectName = managerChats.list().find((m) => m.projectKey === key)?.projectName ?? null;
  if (parsed.project && projectName && parsed.project.toLowerCase() !== projectName.toLowerCase()) {
    return { error: `A report names only tasks of its own project (${projectName}).` };
  }
  if (!row) return { error: `No task ${raw.slice(0, 60)} in this project.` };
  return { taskId: row.id, ref: formatTaskRef(row.number, projectName), title: row.title };
}

/** Whether the chat is a project's manager now: the one question the tool's listing asks. */
export const isReportingManager = (sessionId: string): boolean => managerChats.isManagerChat(sessionId);

/** The tool call: refused unless the caller is a manager chat, checked against the live table. */
export function reportToAssistantCall(sessionId: string, args: unknown, env: ReportEnv = reportEnv): Json {
  const row = managerChats.forSession(sessionId);
  if (!row) {
    log.info(`report from session ${sessionId} refused: not a manager chat`);
    return textResult(NOT_A_MANAGER, true);
  }
  const result = fileReport(env, { sessionId: row.sessionId, projectName: row.projectName, projectPath: row.projectPath }, args);
  if (!result.ok) return textResult(result.message, true);
  return textResult(JSON.stringify({
    ...(result.cardId ? { cardId: result.cardId } : {}), kind: result.kind, ...(result.note ? { note: result.note } : {}),
    ...(result.withdrawn ? { withdrawn: result.withdrawn.map((w) => ({ card: w.card?.id ?? w.ref, outcome: w.outcome })) } : {}),
  }));
}
