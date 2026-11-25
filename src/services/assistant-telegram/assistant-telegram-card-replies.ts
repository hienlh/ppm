/**
 * What the user does to the PPM Assistant's cards from Telegram: a button (OK, one of a card's
 * choices, Approve change, Revert, Send anyway), or a message sent as a reply to a card's message.
 *
 * A reply is matched on the pair (chat, replied-to message id) — Telegram counts message ids per
 * chat, so the same number in another chat is another message. The inbound router has already run
 * its access and backlog checks and flushed the chat's gathered messages; a forwarded message, or
 * one sent through an inline bot, is someone else's words and never answers a card.
 *
 * A card that was DECIDED (an OK, a choice, an Allow or Deny, dismissed, expired, no longer
 * waiting) takes no more words: they would reach its manager as a second answer to a settled
 * question, so they are refused in one line. A card that was only answered in words (a reply)
 * still takes more: that is the conversation with its manager going on, which is how a reply to the
 * manager's answer under the card works. Either of those, or a card older than a day, asks first:
 * "send anyway?". For a card still waiting, Send anyway confirms its age only (`confirmAge`), the
 * same as PPM's set of decisions, so a card decided while the question waited is refused.
 */
import { findCardByTelegramRef } from "../assistant-cards/assistant-cards-outbound-db.ts";
import { chooseCardOption, okCard, replyToCard, type CardReplyResult } from "../assistant-cards/card-reply-actions.ts";
import { assistantCards } from "../assistant-cards/assistant-cards.service.ts";
import { cardWithdrawal, type AssistantCard } from "../../shared/assistant-cards.ts";
import type { CardActor } from "../assistant-cards/forward-verbatim.ts";
import { decideManagerRules } from "../assistant-managers/manager-rules.service.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import type { InlineKeyboardMarkup } from "../telegram/telegram-types.ts";
import type { BridgeAction, ManagerCardPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";

/** What a reply to a card that was already decided is told: nothing is forwarded. */
export const CLOSED_CARD_NOT_SENT = "Not sent: this card was already decided or closed.";

/**
 * Whether a card that no longer waits was settled by a decision, rather than only answered in
 * words: an OK, a choice, an Allow or Deny, dismissed, resolved or gone. Only words leave the card
 * open to more words.
 */
export function cardDecided(card: Pick<AssistantCard, "status" | "answer">): boolean {
  if (card.status === "open" || card.status === "info") return false;
  // Withdrawn by its author, not decided by the user: their words may still be sent, after asking.
  if (cardWithdrawal(card)) return false;
  if (card.status !== "answered") return true;
  const a = card.answer;
  return !a || a.ok === true || !!a.choice || a.approved !== undefined;
}

const MAX_PENDING = 50;
/**
 * The base64 the "send anyway?" questions may hold between them (~45 MB of images): fifty waiting
 * replies of five photos each would otherwise keep over a gigabyte in memory. The oldest go first.
 */
const MAX_PENDING_IMAGE_CHARS = 60_000_000;
/**
 * The manager's answer to the reply comes back here — under the card (`assistant-telegram-card-followups.ts`),
 * or, when the manager answers with a new card, as that card under the user's own message
 * (`assistant-telegram-manager-cards.ts`) — if there is one: a turn with no text, a stopped turn's
 * notice aside, words that never arrived or a bridge stopped meanwhile all send nothing, so this is
 * no promise.
 */
export const ANSWER_FOLLOWS = "If the manager answers, it will come here.";

export interface CardRepliesDeps {
  codes: ButtonCodes<BridgeAction>;
  /** A message to the chat (a confirmation, a question, an error). */
  reply: (chatId: string, html: string, markup?: InlineKeyboardMarkup) => void;
  ok?: typeof okCard;
  choose?: typeof chooseCardOption;
  replyTo?: typeof replyToCard;
  decideRules?: (projectName: string, action: "approve" | "revert", hash: string) => Promise<void>;
  findCard?: typeof findCardByTelegramRef;
  /** The card as it is now, to choose how "Send anyway" confirms (default: the card store). */
  getCard?: (id: string) => AssistantCard | null;
}

type Image = { data: string; mediaType: string };

export interface CardReplyMessage {
  text: string;
  /** The photos sent with the reply, already fetched from Telegram (at most five). */
  images?: Image[];
  replyToMessageId: number;
  /** The user's message itself. */
  messageId?: number;
  /** Forwarded from someone, or sent through an inline bot. */
  notTheUsers: boolean;
}

export class AssistantTelegramCardReplies {
  private readonly pending = new Map<string, { chatId: string; cardId: string; text: string; images: Image[]; messageId?: number }>();

  constructor(private readonly deps: CardRepliesDeps) {}

  /**
   * `replyTo` is the card's message the user answered, where the manager's answer goes too;
   * `messageId` the user's own message, under which a card the manager opens to answer it goes.
   */
  private actor(chatId: string, replyTo?: number, messageId?: number): CardActor {
    return {
      channel: "telegram", telegramChatId: chatId,
      ...(replyTo ? { telegramReplyTo: replyTo } : {}), ...(messageId ? { telegramMessageId: messageId } : {}),
    };
  }

  /** Whether this message of this chat shows one of the Assistant's cards. */
  isCardMessage(chatId: string, messageId: number): boolean {
    return (this.deps.findCard ?? findCardByTelegramRef)(chatId, messageId) !== null;
  }

  /** Whether the message answered a card (and so is not for the Assistant). */
  async reply(chatId: string, m: CardReplyMessage): Promise<boolean> {
    const row = (this.deps.findCard ?? findCardByTelegramRef)(chatId, m.replyToMessageId);
    if (!row) return false;
    if (m.notTheUsers) {
      this.deps.reply(chatId, "A forwarded message cannot answer a card. Reply to the card with your own words.");
      return true;
    }
    const images = m.images ?? [];
    if (!m.text.trim() && !images.length) {
      this.deps.reply(chatId, "To answer a card, reply to it with text or a photo.");
      return true;
    }
    this.answer(
      chatId, row.id,
      await (this.deps.replyTo ?? replyToCard)(row.id, { text: m.text, ...(images.length ? { images } : {}) }, this.actor(chatId, m.replyToMessageId, m.messageId)),
      m.text, images, m.messageId,
    );
    return true;
  }

  /** Drops the oldest questions until both the count and the images they hold fit. */
  private makeRoom(incomingChars: number): void {
    const held = () => [...this.pending.values()].reduce((n, p) => n + p.images.reduce((m, i) => m + i.data.length, 0), 0);
    while (this.pending.size && (this.pending.size >= MAX_PENDING || held() + incomingChars > MAX_PENDING_IMAGE_CHARS)) {
      this.pending.delete(this.pending.keys().next().value!);
    }
  }

  private answer(chatId: string, cardId: string, result: CardReplyResult, text: string, images: Image[], messageId?: number): void {
    if (result.ok) {
      this.deps.reply(chatId, result.to === "manager"
        ? `Sent to the <b>${escapeTelegramHtml(result.projectName ?? "project")}</b> manager, word for word. ${ANSWER_FOLLOWS}`
        : "Sent to the Assistant.");
      return;
    }
    // A decided card is not asked about: more words would be a second answer.
    if (result.error === "already_answered" || (result.error === "confirm" && result.card && cardDecided(result.card))) {
      this.deps.reply(chatId, CLOSED_CARD_NOT_SENT);
      return;
    }
    if (result.error === "confirm" && result.question) {
      this.makeRoom(images.reduce((n, i) => n + i.data.length, 0));
      const pendingId = crypto.randomUUID();
      // The photos are kept with the words: "Send anyway" sends the reply as it was written.
      this.pending.set(pendingId, { chatId, cardId, text, images, ...(messageId ? { messageId } : {}) });
      const code = this.deps.codes.mint(chatId, `anyway:${pendingId}`, { kind: "mcard", cardId, op: "send_anyway", pendingId });
      this.deps.reply(chatId, escapeTelegramHtml(result.question), { inline_keyboard: [[{ text: "Send anyway", callback_data: code }]] });
      return;
    }
    this.deps.reply(chatId, `⚠️ ${escapeTelegramHtml(result.error)}`);
  }

  /** A button on one of the Assistant's cards: the toast to show, after acting. */
  async press(chatId: string, press: ManagerCardPress, group: string): Promise<string> {
    if (press.op === "ok" || press.op === "choose") {
      // The card is checked again here (still open, still offering this choice): a code outlives
      // nothing but the card's own state.
      const result = press.op === "ok"
        ? await (this.deps.ok ?? okCard)(press.cardId, { draftSha256: press.draftSha256 ?? null }, this.actor(chatId))
        : await (this.deps.choose ?? chooseCardOption)(press.cardId, { optionId: press.optionId ?? null }, this.actor(chatId));
      // A forward that failed opened the card again, with a note that sends it out once more with
      // fresh buttons; these codes are spent with the card's old copy either way.
      if (result.ok || result.status !== 502) this.deps.codes.dropGroup(group);
      if (result.ok) return result.to === "manager" ? `Sent to the ${result.projectName ?? "project"} manager.` : "Sent.";
      return (result.question ?? result.error).slice(0, 180);
    }
    this.deps.codes.dropGroup(group);
    if (press.op === "send_anyway") {
      const waiting = press.pendingId ? this.pending.get(press.pendingId) : undefined;
      if (!waiting || waiting.chatId !== chatId || waiting.cardId !== press.cardId) return "This button is no longer valid.";
      this.pending.delete(press.pendingId!);
      // Looked at as it is now, not as it was when the question was asked.
      const now = (this.deps.getCard ?? ((id) => assistantCards.get(id)))(press.cardId);
      if (now && cardDecided(now)) {
        this.answer(chatId, press.cardId, { ok: false, status: 409, error: "already_answered", card: now }, waiting.text, waiting.images, waiting.messageId);
        return "Not sent.";
      }
      // A card still waiting: the same confirmation as PPM's set of decisions, its age only, so a
      // card decided in the meantime is refused by the server too. A card answered only in words:
      // the conversation goes on, which only `force` sends.
      const confirm = now && now.status !== "open" ? { force: true } : { confirmAge: true };
      const result = await (this.deps.replyTo ?? replyToCard)(
        press.cardId, { text: waiting.text, ...confirm, ...(waiting.images.length ? { images: waiting.images } : {}) },
        this.actor(chatId, undefined, waiting.messageId),
      );
      this.answer(chatId, press.cardId, result, waiting.text, waiting.images, waiting.messageId);
      return result.ok ? "Sent." : "Not sent.";
    }
    if (!press.rulesHash || !press.projectName) return "This button is no longer valid.";
    try {
      await (this.deps.decideRules ?? decideManagerRules)(press.projectName, press.op, press.rulesHash);
      return press.op === "approve" ? "Change approved." : "Change reverted.";
    } catch (e) {
      return ((e as Error).message || "Could not decide the change.").slice(0, 180);
    }
  }
}
