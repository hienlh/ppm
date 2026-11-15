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
import { cardPhotosTask } from "./assistant-telegram-card-photos.ts";
import { notificationLink } from "../notification-link.ts";
import { outcomeOf, sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { CardReminders, TelegramSilence } from "./assistant-telegram-silence.ts";
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
  /** Whether the user is at PPM, so a card goes out without a sound. */
  silence?: TelegramSilence;
  /** The one reminder with a sound for a decision sent silently and left unanswered. */
  reminders?: CardReminders;
  /** Whether a card still waits on the user (its row is open). */
  isOpen?: (cardId: string) => boolean;
  /** The link that shows a card's picture full size (`/api/design-shots/<id>.png` on PPM's public address). */
  shotLink?: (id: string) => Promise<string | null>;
}

const realShotLink = (id: string): Promise<string> => notificationLink({ project: "", sessionId: "", path: `/api/design-shots/${id}.png` });

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

  private silent(): boolean {
    return this.deps.silence?.inPpm() ?? false;
  }

  private isOpen(cardId: string): boolean {
    return (this.deps.isOpen ?? ((id) => getCardRow(id)?.status === "open"))(cardId);
  }

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
      if (header) this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: `<b>${escapeTelegramHtml(header)}</b>` }, { label: "away header", silent: () => this.silent() }));
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
        card: live, onSent: record, manager: true, ...(detail === "title" ? { titleOnly: card.title } : {}),
      });
      return;
    }
    const formatted = formatManagerCard(card, detail);
    const group = groupOf(card.id, chatId);
    // The pictures first, so the card to answer them on comes last; never for a title-only project.
    const photos = detail === "full"
      ? cardPhotosTask(chatId, card, {
        link: this.deps.shotLink ?? realShotLink,
        silent: () => card.kind !== "urgent" && this.silent(),
      })
      : null;
    if (photos) this.deps.queue.enqueue(chatId, photos);
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
      label: `${card.kind} card`,
      // An urgent card rings even while the user is at PPM: it is the one kind that asked to be heard.
      silent: () => card.kind !== "urgent" && this.silent(),
      onSent: (sent, info) => {
        record(sent.message_id);
        // A decision sent silently gets one reminder if it is still open later.
        if (info.silent && card.kind === "needs_decision") {
          this.deps.reminders?.schedule({
            chatId, messageId: sent.message_id, label: `${card.kind} card`,
            stillWaiting: () => this.isOpen(card.id),
          });
        }
      },
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
    // A follow-up message is the manager's answer to a reply, not a copy of the card: left as it is.
    const refs = (getCardRow(card.id)?.telegramRefs ?? []).filter((r) => !r.followUp);
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
