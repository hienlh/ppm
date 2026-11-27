/**
 * Words written as a reply to the pinned card desk that could not be matched for certain to one card
 * (`assistant-telegram-cards-desk-reply.ts`): they are kept, never dropped, and the user is asked
 * which card they answer, with a button per card waiting. A press sends the very message on, as a
 * reply to that card's own message; "Send to the Assistant" sends it on as an ordinary message, and
 * "Don't send" is the only way it is dropped.
 *
 * A card the user picks that stopped waiting meanwhile is refused with a toast and the question
 * stays, so they can pick another. Held messages live in memory, like the buttons' codes: after a
 * restart the question's buttons answer "no longer valid", and the words are still on the phone.
 */
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import type { TelegramMessage } from "../telegram/telegram-types.ts";
import type { BridgeAction, DeskPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import { outcomeOf, sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";

/** Questions kept per chat at once; the oldest goes first (its words are still on the phone). */
const HELD_PER_CHAT = 20;
/** Cards offered as buttons; past this, the rest are reached on the desk itself. */
const OPTIONS_MAX = 8;
const LABEL_MAX = 60;
const WORDS_MAX = 160;

export const WHICH_CARD_HEAD = "❓ <b>Which card is this an answer to?</b>";
export const WHICH_CARD_WHY = "PPM could not tell for sure which card you were answering, so it kept your words. Pick the card and they go there.";
export const TO_ASSISTANT_LABEL = "💬 Send to the Assistant instead";
export const DONT_SEND_LABEL = "✖ Don't send";

interface Held {
  chatId: string;
  message: TelegramMessage;
  /** The update it came in, under which it is sent on. */
  updateId: number;
  options: Array<{ key: string; label: string }>;
  /** The question's message, once Telegram has it. */
  questionId: number | null;
  group: string;
}

export interface DeskHeldRepliesDeps {
  codes: ButtonCodes<BridgeAction>;
  queue: AssistantTelegramSendQueue;
  now: () => number;
  /** A waiting card's own message in this chat; null when it no longer waits. */
  cardMessage: (chatId: string, key: string) => number | null;
}

export class DeskHeldReplies {
  private readonly held = new Map<string, Held>();

  constructor(private readonly deps: DeskHeldRepliesDeps) {}

  /** Keeps the message and asks which card it answers. */
  ask(chatId: string, message: TelegramMessage, updateId: number, options: Array<{ key: string; label: string }>, ended: readonly string[]): void {
    const mine = [...this.held.entries()].filter(([, h]) => h.chatId === chatId);
    if (mine.length >= HELD_PER_CHAT) this.drop(mine[0]![0]);
    const id = crypto.randomUUID().slice(0, 12);
    const group = `held:${chatId}:${id}`;
    const shown = options.slice(0, OPTIONS_MAX).map((o) => ({ key: o.key, label: truncateText(redactForTelegram(o.label), LABEL_MAX) }));
    const h: Held = { chatId, message, updateId, options: shown, questionId: null, group };
    this.held.set(id, h);
    const key = (text: string, press: Omit<DeskPress, "kind" | "held">) =>
      ({ text, callback_data: this.deps.codes.mint(chatId, group, { kind: "desk", held: id, ...press }) });
    const rows = [
      ...shown.map((o, i) => [key(`${i + 1}. ${o.label}`, { op: "assign", key: o.key })]),
      [key(TO_ASSISTANT_LABEL, { op: "to_assistant" })],
      [key(DONT_SEND_LABEL, { op: "discard" })],
    ];
    const lines = [WHICH_CARD_HEAD, WHICH_CARD_WHY, `<i>“${escapeTelegramHtml(truncateText(redactForTelegram(wordsOf(message)), WORDS_MAX))}”</i>`];
    if (ended.length) lines.push(`<i>Answered meanwhile: ${escapeTelegramHtml(ended.map((e) => truncateText(redactForTelegram(e), LABEL_MAX)).join("; "))}</i>`);
    if (!shown.length) lines.push("<i>No card is waiting any more.</i>");
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html: lines.join("\n"), markup: { inline_keyboard: rows }, replyTo: message.message_id,
    }, {
      label: "which card",
      onSent: (sent) => { h.questionId = sent.message_id; },
      onDropped: () => this.drop(id),
    }));
  }

  /**
   * A press on a question's button: the toast, and the message to send on (as a reply to the card
   * picked, or to the Assistant), or none.
   */
  take(chatId: string, press: DeskPress, group: string): { toast: string; message?: TelegramMessage; updateId?: number } {
    const id = press.held ?? "";
    const h = this.held.get(id);
    if (!h || h.chatId !== chatId || h.group !== group) return { toast: "This button is no longer valid." };
    if (press.op === "discard") {
      this.close(id, "<i>Not sent.</i>");
      return { toast: "Not sent." };
    }
    if (press.op === "to_assistant") {
      this.close(id, "↪ <i>Sent to the Assistant.</i>");
      return { toast: "Sent to the Assistant.", message: this.resend(h, null), updateId: h.updateId };
    }
    const option = h.options.find((o) => o.key === press.key);
    const target = option ? this.deps.cardMessage(chatId, option.key) : null;
    // Gone meanwhile: the question stays, so another card (or the Assistant) can still be picked.
    if (!option || target === null) return { toast: "That card is no longer waiting — pick another." };
    this.close(id, `↪ <i>Sent as an answer to: ${escapeTelegramHtml(option.label)}</i>`);
    return { toast: "Sent.", message: this.resend(h, target), updateId: h.updateId };
  }

  forgetChat(chatId: string): void {
    for (const [id, h] of [...this.held]) if (h.chatId === chatId) this.drop(id);
  }

  get size(): number {
    return this.held.size;
  }

  /** The kept message as if it had just been sent: a reply to `target`, or to nothing. */
  private resend(h: Held, target: number | null): TelegramMessage {
    const { quote: _quote, reply_to_message: replied, ...rest } = h.message;
    const date = Math.floor(this.deps.now() / 1000);
    return target === null || !replied
      ? { ...rest, date }
      : { ...rest, date, reply_to_message: { ...replied, message_id: target } };
  }

  /** The question ends: its buttons go, and one line says what became of the words. */
  private close(id: string, line: string): void {
    const h = this.held.get(id);
    this.drop(id);
    if (!h || h.questionId === null) return;
    const html = `${WHICH_CARD_HEAD}\n<i>“${escapeTelegramHtml(truncateText(redactForTelegram(wordsOf(h.message)), WORDS_MAX))}”</i>\n${line}`;
    const messageId = h.questionId;
    let attempts = 0;
    this.deps.queue.enqueue(h.chatId, {
      final: true, label: "which card answered",
      run: async (client) => outcomeOf(await client.editMessageText(h.chatId, messageId, html, { final: true }), ++attempts),
    });
  }

  private drop(id: string): void {
    const h = this.held.get(id);
    if (h) this.deps.codes.dropGroup(h.group);
    this.held.delete(id);
  }
}

/** What the message says, for the question to quote it. */
function wordsOf(m: TelegramMessage): string {
  const text = (m.text ?? m.caption ?? "").replace(/\s+/g, " ").trim();
  if (text) return text;
  if (m.voice || m.audio) return "a voice message";
  if (m.photo) return "a photo";
  return "your message";
}
