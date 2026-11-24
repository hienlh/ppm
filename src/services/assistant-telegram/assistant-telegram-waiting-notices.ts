/**
 * The Telegram messages about a chat waiting on a card that carry no buttons: a Design chat's card
 * (answered beside its canvas), an MCP server that needs signing in to again, and the reminder that
 * a card has stood unanswered so long that its chat has done nothing since (`approval_overdue`).
 *
 * Each names the chat and the card's title and links to PPM. A title-only project shows the title
 * the card already carries, nothing of the request itself.
 */
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { clockTime } from "./assistant-telegram-tasks-deck.ts";

export type WaitingNoticeKind = "design" | "mcp_sign_in" | "overdue";

/** Whether the card is sent as a notice rather than relayed with buttons. */
export function isLinkOnlyCard(card: AssistantCard): boolean {
  return card.payload.answerInPpm === "design" || card.payload.answerInPpm === "mcp_sign_in";
}

function asker(card: AssistantCard): string {
  const project = escapeTelegramHtml(card.projectName ?? "a project");
  const chat = card.payload.chat;
  return chat ? `Chat “${escapeTelegramHtml(chat.title)}” in ${project}` : `The ${project} manager chat`;
}

/** The notice's HTML, without its link. `clock` formats a time for the user (tests pass their own). */
export function waitingNoticeHtml(card: AssistantCard, kind: WaitingNoticeKind, clock: (ms: number) => string = clockTime): string {
  const title = escapeTelegramHtml(card.title);
  if (kind === "design") {
    return `🎨 <b>A Design chat waits for you</b>\n${asker(card)}: <b>${title}</b>\nAnswer it in the design in PPM.`;
  }
  if (kind === "mcp_sign_in") {
    const server = escapeTelegramHtml(card.payload.mcpServer ?? "an MCP server");
    return `🔑 <b>${server} needs a sign-in</b>\n${asker(card)} can no longer use it. Sign in from the chat in PPM.`;
  }
  const since = card.payload.waitingSince ?? card.createdAt;
  const who = card.payload.scheduledTurn ? `${asker(card)} (a scheduled run)` : asker(card);
  return `⏰ <b>Still waiting for you since ${escapeTelegramHtml(clock(since))}</b>\n${who} has done nothing since: <b>${title}</b>`;
}
