/**
 * What the user does to the PPM Assistant's cards from Telegram: a button (OK, Approve change,
 * Revert, Send anyway), or a message sent as a reply to a card's message.
 *
 * A reply is matched on the pair (chat, replied-to message id) — Telegram counts message ids per
 * chat, so the same number in another chat is another message. The inbound router has already run
 * its access and backlog checks and flushed the chat's gathered messages; a forwarded message, or
 * one sent through an inline bot, is someone else's words and never answers a card. A card that no
 * longer waits, or is older than a day, asks first: "send anyway?".
 */
import { findCardByTelegramRef } from "../assistant-cards/assistant-cards-outbound-db.ts";
import { okCard, replyToCard, type CardReplyResult } from "../assistant-cards/card-reply-actions.ts";
import type { CardActor } from "../assistant-cards/forward-verbatim.ts";
import { decideManagerRules } from "../assistant-managers/manager-rules.service.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import type { InlineKeyboardMarkup } from "../telegram/telegram-types.ts";
import type { BridgeAction, ManagerCardPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";

const MAX_PENDING = 50;

export interface CardRepliesDeps {
  codes: ButtonCodes<BridgeAction>;
  /** A message to the chat (a confirmation, a question, an error). */
  reply: (chatId: string, html: string, markup?: InlineKeyboardMarkup) => void;
  ok?: typeof okCard;
  replyTo?: typeof replyToCard;
  decideRules?: (projectName: string, action: "approve" | "revert", hash: string) => Promise<void>;
  findCard?: typeof findCardByTelegramRef;
}

export interface CardReplyMessage {
  text: string;
  replyToMessageId: number;
  /** Forwarded from someone, or sent through an inline bot. */
  notTheUsers: boolean;
}

export class AssistantTelegramCardReplies {
  private readonly pending = new Map<string, { chatId: string; cardId: string; text: string }>();

  constructor(private readonly deps: CardRepliesDeps) {}

  private actor(chatId: string): CardActor {
    return { channel: "telegram", telegramChatId: chatId };
  }

  /** Whether the message answered a card (and so is not for the Assistant). */
  async reply(chatId: string, m: CardReplyMessage): Promise<boolean> {
    const row = (this.deps.findCard ?? findCardByTelegramRef)(chatId, m.replyToMessageId);
    if (!row) return false;
    if (m.notTheUsers) {
      this.deps.reply(chatId, "A forwarded message cannot answer a card. Reply to the card with your own words.");
      return true;
    }
    if (!m.text.trim()) {
      this.deps.reply(chatId, "To answer a card, reply to it with text.");
      return true;
    }
    this.answer(chatId, row.id, await (this.deps.replyTo ?? replyToCard)(row.id, { text: m.text }, this.actor(chatId)), m.text);
    return true;
  }

  private answer(chatId: string, cardId: string, result: CardReplyResult, text: string): void {
    if (result.ok) {
      this.deps.reply(chatId, result.to === "manager"
        ? `Sent to the <b>${escapeTelegramHtml(result.projectName ?? "project")}</b> manager, word for word.`
        : "Sent to the Assistant.");
      return;
    }
    if (result.error === "confirm" && result.question) {
      while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      const pendingId = crypto.randomUUID();
      this.pending.set(pendingId, { chatId, cardId, text });
      const code = this.deps.codes.mint(chatId, `anyway:${pendingId}`, { kind: "mcard", cardId, op: "send_anyway", pendingId });
      this.deps.reply(chatId, escapeTelegramHtml(result.question), { inline_keyboard: [[{ text: "Send anyway", callback_data: code }]] });
      return;
    }
    this.deps.reply(chatId, `⚠️ ${escapeTelegramHtml(result.error)}`);
  }

  /** A button on one of the Assistant's cards: the toast to show, after acting. */
  async press(chatId: string, press: ManagerCardPress, group: string): Promise<string> {
    this.deps.codes.dropGroup(group);
    if (press.op === "send_anyway") {
      const waiting = press.pendingId ? this.pending.get(press.pendingId) : undefined;
      if (!waiting || waiting.chatId !== chatId || waiting.cardId !== press.cardId) return "This button is no longer valid.";
      this.pending.delete(press.pendingId!);
      const result = await (this.deps.replyTo ?? replyToCard)(press.cardId, { text: waiting.text, force: true }, this.actor(chatId));
      this.answer(chatId, press.cardId, result, waiting.text);
      return result.ok ? "Sent." : "Not sent.";
    }
    if (press.op === "ok") {
      const result = await (this.deps.ok ?? okCard)(press.cardId, { draftSha256: press.draftSha256 ?? null }, this.actor(chatId));
      if (result.ok) return result.to === "manager" ? `Sent to the ${result.projectName ?? "project"} manager.` : "Sent.";
      return (result.question ?? result.error).slice(0, 180);
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
