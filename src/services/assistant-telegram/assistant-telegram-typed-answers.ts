/**
 * Answers in the user's own words to a question card on Telegram — the "Other" a chat's question
 * form offers beside its choices.
 *
 * Two ways in, both read by `AssistantTelegramCards.typed`:
 * - "✏️ Other" on a question arms the chat: its next message answers that question. The bot says
 *   which question, offers Cancel, and stops waiting after {@link TYPED_ANSWER_WINDOW_MS}, when the
 *   card ends, or when Other is pressed on another card. A message replying to some other message
 *   is not taken, and commands still go to the Assistant.
 * - A message sent as a reply to the card (or to the bot's "type your answer" line) answers the
 *   question on screen, with nothing to arm.
 *
 * Only this module and the card know about it; the inbound router asks the card first and hands the
 * message on to the Assistant when the card does not take it.
 */
import type { NormalizedQuestion } from "../../shared/approval-questions.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";

/** How long the next message stays meant as an answer after Other. */
export const TYPED_ANSWER_WINDOW_MS = 10 * 60_000;
/** How much of the question the "type your answer" line repeats, and of the answer the confirmation. */
const QUESTION_ECHO_MAX = 200;
const ANSWER_ECHO_MAX = 300;
const ARMED_CHATS_MAX = 100;

/** A message of the user's, as far as a typed answer needs it. */
export interface TypedAnswerMessage {
  text: string;
  replyToMessageId?: number;
  /** Forwarded, or sent through an inline bot: someone else's words, which never answer a card. */
  notTheUsers: boolean;
}

/** A chat waiting for its next message to answer one question of one card. */
export interface ArmedAnswer {
  cardKey: string;
  questionId: string;
  until: number;
  /** The bot's "type your answer" line, once sent: a reply to it answers too. */
  promptMessageId: number | null;
}

/** Which chats wait for a typed answer, one card question each. */
export class ArmedAnswers {
  private readonly byChat = new Map<string, ArmedAnswer>();

  arm(chatId: string, armed: ArmedAnswer): void {
    this.byChat.delete(chatId);
    // Bounded: only connected chats can press, but a store kept per chat id must still not grow without end.
    if (this.byChat.size >= ARMED_CHATS_MAX) this.byChat.delete(this.byChat.keys().next().value!);
    this.byChat.set(chatId, armed);
  }

  /** What the chat waits for, unless the window has passed. */
  get(chatId: string, now: number): ArmedAnswer | null {
    const armed = this.byChat.get(chatId);
    if (!armed) return null;
    if (armed.until <= now) {
      this.byChat.delete(chatId);
      return null;
    }
    return armed;
  }

  disarm(chatId: string): void {
    this.byChat.delete(chatId);
  }

  /** The card ended: no chat waits for words to it any more. */
  disarmCard(cardKey: string): void {
    for (const [chatId, armed] of this.byChat) if (armed.cardKey === cardKey) this.byChat.delete(chatId);
  }
}

/** User text the bot repeats back: secrets hidden, cut, escaped. */
export function echoHtml(raw: string, max = ANSWER_ECHO_MAX): string {
  const plain = redactForTelegram(raw.replace(/\s+/g, " ").trim());
  const chars = Array.from(plain);
  return escapeTelegramHtml(chars.length <= max ? plain : `${chars.slice(0, max - 1).join("").trimEnd()}…`);
}

/** The line Other draws: which question the next message answers. */
export function typedPromptHtml(q: NormalizedQuestion, minutes = Math.round(TYPED_ANSWER_WINDOW_MS / 60_000)): string {
  return `✏️ Type your answer to: <b>${echoHtml(q.question, QUESTION_ECHO_MAX)}</b>\n`
    + `<i>Your next message is the answer. Send it within ${minutes} minutes, or press Cancel. Commands still go to the Assistant.</i>`;
}

export const answerSentHtml = (text: string): string => `✅ Answer sent: <b>${echoHtml(text)}</b>`;
