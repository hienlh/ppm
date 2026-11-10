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
import { countSessionCardsSince, findOpenUrgentTitled } from "./assistant-cards-db.ts";
import { DIGEST_NOT_ASKED, fileReport, type ReportEnv } from "./manager-report-tool.ts";

/** Refused for every chat but a project's current manager chat. */
export const NOT_A_MANAGER = "Only a project's manager chat can report to PPM Assistant. Answer the user in this chat instead.";

type DigestAnswerHandler = ReportEnv["digestAnswer"];

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
  quietWindowStart: currentQuietWindowStart,
  digestAnswer: (sessionId, items) => digestAnswers(sessionId, items),
  create: (card) => assistantCards.create(card),
};

/** Whether the chat is a project's manager now: the one question the tool's listing asks. */
export const isReportingManager = (sessionId: string): boolean => managerChats.isManagerChat(sessionId);

/** The tool call: refused unless the caller is a manager chat, checked against the live table. */
export function reportToAssistantCall(sessionId: string, args: unknown, env: ReportEnv = reportEnv): Json {
  const row = managerChats.forSession(sessionId);
  if (!row) return textResult(NOT_A_MANAGER, true);
  const result = fileReport(env, { sessionId: row.sessionId, projectName: row.projectName, projectPath: row.projectPath }, args);
  if (!result.ok) return textResult(result.message, true);
  return textResult(JSON.stringify({
    ...(result.cardId ? { cardId: result.cardId } : {}), kind: result.kind, ...(result.note ? { note: result.note } : {}),
  }));
}
