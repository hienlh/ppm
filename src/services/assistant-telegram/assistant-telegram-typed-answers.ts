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
 *   question on screen, with nothing to arm — when that question takes words. Any other reply (a
 *   photo, a question with choices only, a card shown without buttons) goes on to the chat word for
 *   word, as replies to a card always did.
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
  /** It carries a photo: a reply with one goes on to the chat whole, as it always did. */
  hasPhoto?: boolean;
}

/** A chat waiting for its next message to answer one question of one card. */
export interface ArmedAnswer {
  cardKey: string;
  questionId: string;
  until: number;
  /** The bot's "type your answer" line, once sent: a reply to it answers too, and it is edited when the wait ends. */
  promptMessageId: number | null;
  /** That line's first part, kept so the edit can say how the wait ended under it. */
  promptHead: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Set once the wait is over, so a line still on its way is closed as soon as it is sent. */
  endedWhy?: WaitEnded;
}

/** Why a chat stopped waiting for a typed answer, as the "type your answer" line then says. */
export const WAIT_ENDED = {
  answered: "Answer taken.",
  cancelled: "Cancelled. Your next message goes to the Assistant.",
  expired: "No longer waiting: the time ran out. Your next message goes to the Assistant.",
  moved: "No longer waiting: the card moved on. Press ✏️ Other again to type an answer.",
  replaced: "No longer waiting: you pressed ✏️ Other on another question.",
  elsewhere: "No longer waiting: your next message goes elsewhere.",
  ended: "No longer waiting: the card is no longer open.",
} as const;
export type WaitEnded = keyof typeof WAIT_ENDED;

/**
 * Which chats wait for a typed answer, one card question each. Every way a wait ends (an answer,
 * Cancel, the window passing, the card moving on or ending, another wait in its place) goes
 * through `onEnd`, which edits the "type your answer" line so it never claims to wait when it does not.
 */
export class ArmedAnswers {
  private readonly byChat = new Map<string, ArmedAnswer>();

  constructor(private readonly onEnd: (chatId: string, armed: ArmedAnswer, why: WaitEnded) => void = () => {}) {}

  arm(chatId: string, armed: ArmedAnswer, now: number): void {
    this.end(chatId, "replaced");
    // Bounded: only connected chats can press, but a store kept per chat id must still not grow without end.
    if (this.byChat.size >= ARMED_CHATS_MAX) this.end(this.byChat.keys().next().value!, "expired");
    armed.timer = setTimeout(() => { if (this.byChat.get(chatId) === armed) this.end(chatId, "expired"); }, Math.max(0, armed.until - now));
    (armed.timer as { unref?: () => void }).unref?.();
    this.byChat.set(chatId, armed);
  }

  /** What the chat waits for, unless the window has passed. */
  get(chatId: string, now: number): ArmedAnswer | null {
    const armed = this.byChat.get(chatId);
    if (!armed) return null;
    if (armed.until <= now) {
      this.end(chatId, "expired");
      return null;
    }
    return armed;
  }

  /** The chat stops waiting, for `why`; nothing happens when it was not waiting. */
  end(chatId: string, why: WaitEnded): void {
    const armed = this.byChat.get(chatId);
    if (!armed) return;
    this.byChat.delete(chatId);
    if (armed.timer) clearTimeout(armed.timer);
    this.onEnd(chatId, armed, why);
  }

  /** No chat waits for words to this card any more. */
  endCard(cardKey: string, why: WaitEnded): void {
    for (const [chatId, armed] of [...this.byChat]) if (armed.cardKey === cardKey) this.end(chatId, why);
  }

  /** Forgets a chat without a word (it was disconnected: nothing more is sent to it). */
  forget(chatId: string): void {
    const armed = this.byChat.get(chatId);
    if (armed?.timer) clearTimeout(armed.timer);
    this.byChat.delete(chatId);
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
  return `${typedPromptHead(q)}\n`
    + `<i>Your next message is the answer. Send it within ${minutes} minutes, or press Cancel. Commands still go to the Assistant.</i>`;
}

/** The line's first part, which stays when the wait ends. */
export const typedPromptHead = (q: NormalizedQuestion): string => `✏️ Type your answer to: <b>${echoHtml(q.question, QUESTION_ECHO_MAX)}</b>`;

/** The line once the wait is over: the question, and how it ended. */
export const promptEndedHtml = (head: string, why: WaitEnded): string => `${head}\n<i>${escapeTelegramHtml(WAIT_ENDED[why])}</i>`;

export const answerSentHtml = (text: string): string => `✅ Answer sent: <b>${echoHtml(text)}</b>`;
