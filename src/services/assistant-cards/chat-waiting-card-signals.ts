import { createLogger } from "../logger.ts";
import type { ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import type { LiveApprovalCard } from "../chat-control/chat-control.ts";
import { decidingInput } from "../chat-control/approval-deciding-input.ts";
import { normalizeClaudeQuestions } from "../../shared/approval-questions.ts";
import type { AssistantCardPayload } from "../../shared/assistant-cards.ts";
import { cleanCardTitle } from "./card-text-cleaning.ts";
import type { AssistantCards, NewCard } from "./assistant-cards.service.ts";
import type { CardRow } from "./assistant-cards-db.ts";

/**
 * The cards a chat waits on, as the PPM Assistant mirrors them (`manager-signals.ts` listens and
 * calls these): one built the same way whether the card is in front of the chat or queued behind
 * another, a queued one moved to the front, one left unanswered too long, and an MCP server that
 * stopped working mid-session and needs a sign-in.
 *
 * A Design chat's card is a link only: answered in its design's tab, never off it.
 */

/** Where a chat's waiting card goes: its manager's card, or the chat's own (see `ownerOf`). */
export interface CardOwner {
  projectName: string;
  projectPath: string;
  sessionId: string;
  chat?: { title: string; providerId: string };
  design?: { slug: string };
}

export interface WaitingCardDeps {
  cards: Pick<AssistantCards, "create" | "patchPayload">;
  openRequestCard(requestId: string): CardRow | null;
  /** Takes vault values out of what the card stores; unchanged when left out. */
  scrub?<T>(value: T, sessionId: string): T;
}

const log = createLogger("assistant-cards");

export const DESIGN_REASON = "Answer it in the design in PPM: a Design chat is answered where its canvas is.";
export const MCP_SIGN_IN_REASON = "Sign in from the chat in PPM; the chat cannot use the server until then.";

/** The card mirroring `card` of the chat, ready to be stored. */
export function mirrorCardInput(
  owner: CardOwner, card: LiveApprovalCard, sourceSessionId: string, deps: Pick<WaitingCardDeps, "scrub">,
  extra: Partial<AssistantCardPayload> = {},
): NewCard {
  const scrub = <T>(v: T): T => (deps.scrub ? deps.scrub(v, sourceSessionId) : v);
  const deciding = scrub(decidingInput(card));
  const question = card.isQuestion;
  const questions = scrub(question ? (card.questions ?? normalizeClaudeQuestions(card.input)) : []);
  const first = questions[0]?.question;
  return {
    kind: question ? "question" : "approval",
    projectName: owner.projectName, projectPath: owner.projectPath, sessionId: owner.sessionId,
    title: question ? cleanCardTitle(first, "Question") : cleanCardTitle(deciding.title, "Approval"),
    payload: {
      requestId: card.requestId,
      ...(question ? { questions } : { deciding }),
      ...(owner.chat ? { chat: owner.chat } : {}),
      ...(owner.design ? { answerInPpm: "design" as const, design: owner.design } : {}),
      ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
      ...extra,
    },
  };
}

/** A card waits behind another of its chat: mirrored now, with nothing to press until it is in front. */
export function mirrorQueuedCard(owner: CardOwner | null, p: ChatLifecycleEvents["approval_queued"], deps: WaitingCardDeps): void {
  if (!owner || deps.openRequestCard(p.card.requestId)) return;
  deps.cards.create(mirrorCardInput(owner, p.card, p.sessionId, deps, { queued: true }));
}

/**
 * A card reached the front of its chat. One mirrored while it was queued is now answerable (its
 * buttons appear and Telegram sends it); true when such a card was found, so no second is made.
 */
export function promoteQueuedCard(p: ChatLifecycleEvents["approval_shown"], deps: WaitingCardDeps): boolean {
  const row = deps.openRequestCard(p.card.requestId);
  if (!row) return false;
  if (row.payload.queued) deps.cards.patchPayload(row.id, { queued: undefined }, "shown");
  return true;
}

/** A card unanswered past `APPROVAL_OVERDUE_MS`: its mirror says since when, and rings once more. */
export function markOverdueCard(p: ChatLifecycleEvents["approval_overdue"], deps: WaitingCardDeps): void {
  const row = deps.openRequestCard(p.requestId);
  if (!row || row.payload.waitingSince) return;
  deps.cards.patchPayload(row.id, { waitingSince: p.shownAt, ...(p.scheduled ? { scheduledTurn: true } : {}) }, "overdue");
}

/** The request id an MCP sign-in card is kept under: one open card per project and server. */
export const mcpSignInRequestId = (projectPath: string, server: string): string => `mcp-sign-in:${projectPath}:${server}`;

/** MCP servers that stopped working in a chat: one card each, unless one already waits. */
export function raiseMcpSignInCards(owner: CardOwner | null, p: ChatLifecycleEvents["mcp_sign_in_needed"], deps: WaitingCardDeps): void {
  if (!owner) return;
  for (const server of p.servers) {
    const requestId = mcpSignInRequestId(owner.projectPath, server);
    if (deps.openRequestCard(requestId)) continue;
    const title = cleanCardTitle(`Sign in to ${server}`, "MCP sign-in");
    deps.cards.create({
      kind: "approval",
      projectName: owner.projectName, projectPath: owner.projectPath, sessionId: owner.sessionId,
      title,
      payload: {
        requestId,
        answerInPpm: "mcp_sign_in",
        mcpServer: server,
        deciding: { kind: "mcp_sign_in", title, facts: [], text: "", complete: false, incompleteReason: MCP_SIGN_IN_REASON },
        ...(owner.chat ? { chat: owner.chat } : {}),
      },
    });
    log.info(`session=${p.sessionId} MCP server ${server} needs a sign-in again`);
  }
}
