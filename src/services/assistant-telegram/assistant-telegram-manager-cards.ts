/**
 * The PPM Assistant's cards on Telegram: every connected chat gets each card the outbound gate
 * lets through (`card-outbound.ts`), formatted at the project's detail level, with its buttons
 * behind codes and its message ids recorded as (chat, message) pairs, which is how a reply to it is
 * found. When a card stops waiting, every copy loses its buttons and says how it ended.
 *
 * A manager chat's approval or question goes out as the relay's own card (the same Allow rule,
 * answering the manager chat directly), and that card ends itself when the request does.
 */
import { chatControl, type LiveApprovalCard } from "../chat-control/chat-control.ts";
import { getSessionProvider, getSessionTitle } from "../db.service.ts";
import { projectTelegramDetail } from "../assistant-managers/manager-chats-db.ts";
import { getMainSession } from "../assistant/assistant-main-session.ts";
import { addCardTelegramRef, setCardOutboundError } from "../assistant-cards/assistant-cards-outbound-db.ts";
import { getCardRow } from "../assistant-cards/assistant-cards-db.ts";
import type { CardOutboundSink } from "../assistant-cards/card-outbound.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { canSendTo, reachableChats } from "./assistant-telegram-access.ts";
import type { BridgeAction } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import type { RelayedCard } from "./assistant-telegram-cards.ts";
import { cardEndLine, formatManagerCard, type CardDetail } from "./assistant-telegram-card-kinds.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { outcomeOf, sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export interface ManagerCardsDeps {
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  chatLink: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
  sessionLink: (providerId: string, sessionId: string) => Promise<string>;
  relayCard: (chatId: string, card: RelayedCard) => void;
  isShowing: (chatId: string, requestId: string) => boolean;
  recipients?: () => string[];
  detailOf?: (card: AssistantCard) => CardDetail;
  liveCard?: (sessionId: string, requestId: string) => LiveApprovalCard | null;
}

const groupOf = (cardId: string, chatId: string): string => `mcard:${cardId}:${chatId}`;

/**
 * A project's detail level outlives its manager chat. A card of a project PPM has no setting for
 * gets the title only: the safe side for work whose details must not reach a phone. PPM's own
 * cards with no project (the digest, a budget pause) are shown in full; the digest keeps each
 * project's own level inside it.
 */
function realDetail(card: AssistantCard): CardDetail {
  if (!card.projectKey) return "full";
  return projectTelegramDetail(card.projectKey) ?? "title";
}

function realLiveCard(sessionId: string, requestId: string): LiveApprovalCard | null {
  const card = chatControl()?.liveState(sessionId)?.card;
  return card && card.requestId === requestId ? card : null;
}

export class AssistantTelegramManagerCards implements CardOutboundSink {
  constructor(private readonly deps: ManagerCardsDeps) {}

  private recipients(): string[] {
    return (this.deps.recipients ?? (() => reachableChats().map((c) => c.chatId)))().filter(canSendTo);
  }

  private detail(card: AssistantCard): CardDetail {
    try { return (this.deps.detailOf ?? realDetail)(card); } catch { return "title"; }
  }

  ready(): boolean {
    return this.recipients().length > 0;
  }

  send(cards: AssistantCard[], header?: string): void {
    void this.sendAll(cards, header).catch((e) => log.warn(`cards not sent to Telegram: ${(e as Error).message}`));
  }

  private async sendAll(cards: AssistantCard[], header?: string): Promise<void> {
    const chats = this.recipients();
    if (!chats.length) return;
    // Links first, so every chat's lane gets the header and the cards in order.
    const links = await Promise.all(cards.map((c) => this.linkFor(c).catch(() => null)));
    for (const chatId of chats) {
      if (header) this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: `<b>${escapeTelegramHtml(header)}</b>` }, { label: "away header" }));
      cards.forEach((card, i) => this.sendOne(chatId, card, links[i] ?? null));
    }
  }

  private async linkFor(card: AssistantCard): Promise<string | null> {
    if (card.sessionId && card.projectName) {
      return this.deps.chatLink(card.projectName, getSessionProvider(card.sessionId), card.sessionId);
    }
    const main = getMainSession();
    return main ? this.deps.sessionLink(main.providerId, main.sessionId) : null;
  }

  private sendOne(chatId: string, card: AssistantCard, url: string | null): void {
    const record = (messageId: number) => addCardTelegramRef(card.id, { chatId, messageId });
    const detail = this.detail(card);
    if (card.kind === "approval" || card.kind === "question") {
      const requestId = card.payload.requestId;
      const live = card.sessionId && requestId ? (this.deps.liveCard ?? realLiveCard)(card.sessionId, requestId) : null;
      if (!live || this.deps.isShowing(chatId, live.requestId)) return;
      this.deps.relayCard(chatId, {
        targetSessionId: card.sessionId!, targetProject: card.projectName ?? "project",
        targetProvider: getSessionProvider(card.sessionId!) ?? "claude", targetTitle: getSessionTitle(card.sessionId!) || "Manager",
        card: live, onSent: record, ...(detail === "title" ? { titleOnly: card.title } : {}),
      });
      return;
    }
    const formatted = formatManagerCard(card, detail);
    const group = groupOf(card.id, chatId);
    const row: InlineKeyboardButton[] = formatted.buttons.map((b) => ({
      text: b.text,
      callback_data: this.deps.codes.mint(chatId, group, {
        kind: "mcard", cardId: card.id, op: b.op,
        ...(b.op === "ok" && card.payload.draft ? { draftSha256: card.payload.draft.sha256 } : {}),
        ...(b.op !== "ok" && card.payload.rulesHash ? { rulesHash: card.payload.rulesHash, projectName: card.projectName ?? "" } : {}),
      }),
    }));
    const link = url ? placeLink(url) : {};
    let html = formatted.html;
    if (link.inline) html += `\n\n${link.inline}`;
    const rows = [...(row.length ? [row] : []), ...(link.button ? [[link.button]] : [])];
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html,
      ...(rows.length ? { markup: { inline_keyboard: rows } } : {}),
      ...(link.button ? { fallbackHtml: `${html}\n\n${escapeTelegramHtml(link.button.text)}: ${escapeTelegramHtml(link.button.url!)}` } : {}),
    }, {
      label: `${card.kind} card`, onSent: (sent) => record(sent.message_id),
      // Refused (a 400 is never retried), past its deadline or its chat gone: on record, not assumed sent.
      onDropped: (why) => {
        this.deps.codes.dropGroup(group);
        try { setCardOutboundError(card.id, why, Date.now()); } catch (e) { log.warn(`card ${card.id}: could not record the failed send: ${(e as Error).message}`); }
      },
    }));
  }

  changed(card: AssistantCard): void {
    // The relay's own cards end themselves when their request does.
    if (card.kind === "approval" || card.kind === "question") return;
    const refs = getCardRow(card.id)?.telegramRefs ?? [];
    const html = `${formatManagerCard(card, this.detail(card)).html}\n\n${cardEndLine(card)}`;
    for (const ref of refs) {
      this.deps.codes.dropGroup(groupOf(card.id, ref.chatId));
      if (!canSendTo(ref.chatId)) continue;
      let attempts = 0;
      this.deps.queue.enqueue(ref.chatId, {
        final: true, label: "card ended",
        run: async (client) => outcomeOf(await client.editMessageText(ref.chatId, ref.messageId, html, { final: true }), ++attempts),
      });
    }
  }
}
