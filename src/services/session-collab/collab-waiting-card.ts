import { normalizeClaudeQuestions, type NormalizedQuestion } from "../../shared/approval-questions.ts";
import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import { DB_EXECUTE_APPROVAL } from "../../shared/db-ai-tools.ts";
import { sessionCollabApprovalInput, WAITING_CARD_TITLE_MAX, type WaitingCard } from "../../shared/session-collab.ts";
import { neutralizeFences } from "../../shared/untrusted-text.ts";
import { collabApprovalTitle } from "../notification-format.ts";

/**
 * The card a session is waiting on the user for, as the session tools name it to another AI: its
 * kind and a short title. Pure, so the chat registry, the waits and their tests share one wording.
 *
 * The title is the first question of a question card, else what an approval card asks to run (a
 * session tool's card in its own words, a database change, an Assistant card's headline, else the
 * tool's name). It is another AI's text, cut to one line and with its code fences broken, like
 * every status line the tools hand back.
 */

/** A pending card as the chat registry holds it. */
export interface PendingCardLike {
  tool: string;
  input?: unknown;
  summary?: Pick<ApprovalSummary, "headline">;
  questions?: readonly Pick<NormalizedQuestion, "question">[];
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > WAITING_CARD_TITLE_MAX ? `${flat.slice(0, WAITING_CARD_TITLE_MAX - 1)}…` : flat;
}

export function waitingCardOf(card: PendingCardLike): WaitingCard {
  if (card.tool === "AskUserQuestion") {
    const questions = card.questions?.length ? card.questions : normalizeClaudeQuestions(card.input);
    const first = questions[0]?.question?.trim();
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    return { kind: "question", title: neutralizeFences(oneLine(first ? `${first}${more}` : "A question")) };
  }
  const collab = sessionCollabApprovalInput(card.tool, card.input);
  const what = collab ? collabApprovalTitle(collab)
    : card.tool === DB_EXECUTE_APPROVAL ? "A database change"
    : card.summary?.headline?.trim() || card.tool || "An approval";
  return { kind: "approval", title: neutralizeFences(oneLine(what)) };
}

/**
 * The session a session tool's card was raised to message, if it is one: the card stands between
 * that session's wait and the reply it waits for, so it does not end that wait (the reply, once
 * the user allows it, is the wait's result).
 */
export function cardRaisedFor(card: PendingCardLike): string | null {
  const collab = sessionCollabApprovalInput(card.tool, card.input);
  return collab && "targetSessionId" in collab && typeof collab.targetSessionId === "string" ? collab.targetSessionId : null;
}
