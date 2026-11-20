/**
 * A bound session's approval and question cards, on Telegram, with buttons that answer them.
 *
 * It is the same card PPM shows, answered through the same `answerApproval` the browser uses, so
 * whichever answer comes first wins and the other is told the card is gone. Every way a card
 * leaves — answered here, in PPM or by the Assistant, the turn ending, a new message — arrives as
 * `approval_resolved`, and the Telegram card then loses its buttons and says why.
 *
 * Cards of other chats come here too — a watched chat's, or what `/status` lists — headed with
 * that chat's name and linking to it; their buttons answer that chat.
 *
 * Each card is a new message (an edit would not buzz the phone). Pressing Allow or Deny spends
 * every button of that card. A question card with more than one question, or one question that
 * takes several choices, is asked one question at a time in that same message and answered only
 * by Send on its summary (`assistant-telegram-question-wizard.ts`). A question that takes typed
 * text has "✏️ Other" too, and a reply to the card answers it in words
 * (`assistant-telegram-typed-answers.ts`).
 */
import { chatControl, type LiveApprovalCard } from "../chat-control/chat-control.ts";
import type { ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { answersByIdError, type AnswersById, type NormalizedQuestion } from "../../shared/approval-questions.ts";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/telegram-types.ts";
import { redactForTelegram, stripTelegramHtml } from "../telegram/telegram-html-format.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import type { CardPress } from "./assistant-telegram-actions.ts";
import type { BridgeCards, BridgeDeps } from "./assistant-telegram.service.ts";
import { formatApprovalCard, formatQuestionCard, needsPpm, otherButtonLabel, resolutionLine } from "./assistant-telegram-card-format.ts";
import {
  ArmedAnswers, TYPED_ANSWER_WINDOW_MS, answerSentHtml, promptEndedHtml, typedPromptHead, typedPromptHtml,
  type ArmedAnswer, type TypedAnswerMessage,
} from "./assistant-telegram-typed-answers.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { assistantNameForMessages, getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import {
  EARLIER_STEP, applyTypedAnswer, applyWizardPress, asksStepByStep, buttonLabel, mintWizardCodes, questionListHtml, wizardStepHtml, wizardStepRows,
  wizardWorstCaseSteps, type Mint, type Selection, type WizardState,
} from "./assistant-telegram-question-wizard.ts";
import { BUTTON_URL_INVALID, EDIT_INTERVAL_MS, outcomeOf, sendMessageTask } from "./assistant-telegram-send-queue.ts";
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import { createLogger } from "../logger.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";

const log = createLogger("assistant-telegram");

function inQuietHours(): boolean {
  try { return currentQuietWindowEnd() !== null; } catch { return false; }
}

/** Room left under Telegram's 4096 for the link line under a card. */
const CARD_VISIBLE_MAX = 3900;
const CARD_TITLE_MAX = 80;

/** A card of a chat other than the Assistant's own, and where that chat lives. */
export interface RelayedCard {
  targetSessionId: string;
  targetProject: string;
  targetProvider: string;
  targetTitle: string;
  card: LiveApprovalCard;
  /**
   * A manager chat's card on a project whose Telegram detail is "title": only this title is shown,
   * and only Deny is offered — Allow would approve what the phone was not shown.
   */
  titleOnly?: string;
  /** Called with the message id once the card is on the phone (replies to it are matched by it). */
  onSent?: (messageId: number) => void;
  /**
   * Shown because the user asked for it on this phone (`/status`): they are holding it, so it goes
   * out as before — with a sound, and no reminder — whether or not they are also at PPM.
   */
  askedOnPhone?: boolean;
  /**
   * A project's manager chat: its turn is stopped on this card, so the headline says the chat is
   * waiting for the user rather than merely asking — read in a stream of answers, "asks" looked
   * like one more line of the conversation.
   */
  manager?: boolean;
}

/** What a card is, whoever's it is. */
type CardSource = Pick<ChatLifecycleEvents["approval_shown"], "sessionId" | "providerId" | "card">;

/** How a card is introduced, and where its Open in PPM goes. */
interface CardPresentation {
  approvalHeadline: string;
  questionHeadline: string;
  link: () => Promise<string>;
  titleOnly?: string;
  onSent?: (messageId: number) => void;
  /** Never silent: the user asked for it on the phone. */
  askedOnPhone?: boolean;
}

/** A chat or project name inside a card's headline: plain (the headline is escaped), redacted, short. */
function titleForCard(raw: string): string {
  return truncateText(redactForTelegram(raw.replace(/\s+/g, " ").trim() || "Untitled"), CARD_TITLE_MAX);
}

interface ShownCard {
  chatId: string;
  sessionId: string;
  requestId: string;
  group: string;
  /** What it says once it is no longer waiting; on a card shown in one step, also what it says until then. */
  html: string;
  isQuestion: boolean;
  questions: NormalizedQuestion[];
  /** Choices picked or ticked on a card asked step by step, sent together by Send. */
  selection: Selection;
  /** A card asked one question at a time: the step it is on (`questions.length` is the summary). */
  wizard: WizardState | null;
  /** Its text and buttons as they stand now. */
  view: () => { html: string; rows: InlineKeyboardButton[][] };
  /** Telegram refused the Open in PPM button: the card carries the link in its text instead. */
  linkRefused: boolean;
  messageId: number | null;
  done: boolean;
  /** Why it is no longer waiting, shown under it once it is done. */
  endLine: string | null;
  /** The card's headline, as the line saying it expired names it. */
  headline: string;
  /** Its questions are shown whole with buttons, so words typed to it may answer them. */
  takesWords: boolean;
}

/**
 * "21:09": a deadline as the person reads a clock — in the time zone saved in the Assistant's
 * settings (the server's own when none is), since PPM often runs in UTC far from its user.
 */
function clockTime(ms: number, zone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(zone ? { timeZone: zone } : {}) }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  }
}

function assistantZone(): string | undefined {
  try { return getAssistantSettings().timezone ?? undefined; } catch { return undefined; }
}

/** The line on a card that gives up by itself: how long is left, and that nothing runs after. */
export function expiryLine(expiresAt: number, now: number, zone: string | undefined = assistantZone()): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
  return `⏳ <i>Expires in ${minutes} minute${minutes === 1 ? "" : "s"} (at ${clockTime(expiresAt, zone)}). If nobody answers by then, nothing is done.</i>`;
}

/** The one line sent under a card that ran out with nobody answering. */
export function expiredNoticeHtml(headline: string): string {
  return `⌛ <b>This card expired</b>: ${escapeTelegramHtml(headline)}. Nobody answered in time, so nothing was done.`;
}

export class AssistantTelegramCards implements BridgeCards {
  private readonly cards = new Map<string, ShownCard>();
  /** Chats waiting for a typed answer; when a wait ends, its "type your answer" line says how. */
  private readonly armed = new ArmedAnswers((chatId, waited, why) => {
    waited.endedWhy = why;
    this.closePrompt(chatId, waited);
  });

  constructor(private readonly deps: BridgeDeps) {}

  shown(chatId: string, p: ChatLifecycleEvents["approval_shown"]): void {
    const name = assistantNameForMessages();
    this.showSafely(chatId, p, {
      approvalHeadline: `${name} wants to`,
      questionHeadline: `${name} asks`,
      link: () => this.deps.sessionLink(p.providerId, p.sessionId),
    });
  }

  /**
   * Another chat's card, shown here because the user asked to hear about that chat (a watch) or
   * asked what is waiting (`/status`). Same rules, same buttons; they answer that chat directly.
   */
  relayed(chatId: string, p: RelayedCard): void {
    const where = `“${titleForCard(p.targetTitle)}” in ${titleForCard(p.targetProject)}`;
    this.showSafely(chatId, { sessionId: p.targetSessionId, providerId: p.targetProvider, card: p.card }, {
      ...(p.manager ? {
        approvalHeadline: `Manager chat ${where} is stopped, waiting for your decision`,
        questionHeadline: `Manager chat ${where} is stopped, waiting for your answer`,
      } : {
        approvalHeadline: `Chat ${where} needs your decision`,
        questionHeadline: `Chat ${where} asks`,
      }),
      link: () => this.deps.chatLink(p.targetProject, p.targetProvider, p.targetSessionId),
      ...(p.titleOnly !== undefined ? { titleOnly: p.titleOnly } : {}),
      ...(p.onSent ? { onSent: p.onSent } : {}),
      ...(p.askedOnPhone ? { askedOnPhone: true } : {}),
    });
  }

  /** Whether this chat already shows (or is about to show) that card. */
  isShowing(chatId: string, requestId: string): boolean {
    return this.cards.has(`${chatId}|${requestId}`);
  }

  private showSafely(chatId: string, p: CardSource, how: CardPresentation): void {
    void this.show(chatId, p, how).catch((e) => log.warn(`Card for Telegram chat ${chatId} not shown: ${(e as Error).message}`));
  }

  private async show(chatId: string, p: CardSource, how: CardPresentation): Promise<void> {
    const key = `${chatId}|${p.card.requestId}`;
    if (this.cards.has(key)) return;
    const group = `card:${key}`;
    const questions = p.card.isQuestion ? p.card.questions ?? [] : [];
    const card: ShownCard = {
      chatId, sessionId: p.sessionId, requestId: p.card.requestId, group, html: "", isQuestion: p.card.isQuestion,
      questions, selection: new Map(), wizard: null, view: () => ({ html: card.html, rows: [] }), linkRefused: false,
      messageId: null, done: false, endLine: null,
      headline: p.card.isQuestion ? how.questionHeadline : how.approvalHeadline,
      takesWords: false,
    };
    // Registered before the link is looked up, so a card answered meanwhile is known to be done.
    this.cards.set(key, card);
    const link = placeLink(await how.link());
    if (card.done) {
      this.cards.delete(key);
      return;
    }
    const mint: Mint = (press) =>
      this.deps.codes.mint(chatId, group, { kind: "card", sessionId: p.sessionId, requestId: p.card.requestId, ...press });

    const inlineLink = link.inline ? `\n\n${link.inline}` : "";
    const linkRow = link.button ? [[link.button]] : [];
    // Telegram refusing the link as a button: the link goes in the text instead.
    const linkText = link.button ? `\n\n${escapeTelegramHtml(link.button.text)}: ${escapeTelegramHtml(link.button.url!)}` : "";
    /** What the link adds to the text at most, whichever way it ends up shown. */
    const linkRoom = Math.max(visibleLength(inlineLink), visibleLength(linkText));

    let rows: () => InlineKeyboardButton[][] = () => [];
    /** A step-by-step card's current step; anything else shows `card.html` throughout. */
    let stepHtml: (() => string) | null = null;
    if (how.titleOnly !== undefined) {
      // The project keeps its details off the phone: the title, and nothing that acts on the rest.
      const headline = card.isQuestion ? how.questionHeadline : how.approvalHeadline;
      card.html = `${card.isQuestion ? "❓" : "🔐"} <b>${escapeTelegramHtml(headline)}</b>\n<b>${escapeTelegramHtml(titleForCard(how.titleOnly))}</b>`;
      if (!card.isQuestion) {
        const deny = [{ text: "Deny", callback_data: mint({ op: "deny" }) }];
        rows = () => [deny];
      }
    } else if (card.isQuestion) {
      const headline = how.questionHeadline;
      const tooLong = `❓ <b>${escapeTelegramHtml(headline)}</b>\nThis question is too long to show here — answer it in PPM.`;
      const answerable = questions.length > 0 && !questions.some(needsPpm);
      if (answerable && asksStepByStep(questions)) {
        if (wizardWorstCaseSteps(questions, headline).some((h) => visibleLength(h) + linkRoom > CARD_VISIBLE_MAX)) {
          card.html = tooLong;
        } else {
          const codes = mintWizardCodes(questions, mint);
          const wizard = { step: 0, codes };
          card.wizard = wizard;
          card.html = questionListHtml(questions, headline);
          if (visibleLength(card.html) > CARD_VISIBLE_MAX) card.html = `❓ <b>${escapeTelegramHtml(headline)}</b>`;
          stepHtml = () => wizardStepHtml(questions, wizard.step, card.selection, headline);
          rows = () => wizardStepRows(questions, wizard.step, card.selection, codes);
          card.takesWords = true;
        }
      } else {
        // One question, one choice — or a question only PPM can take, shown whole with no buttons.
        card.html = formatQuestionCard(questions, headline, answerable);
        if (visibleLength(card.html) > CARD_VISIBLE_MAX) card.html = tooLong;
        else if (answerable) {
          rows = singlePickRows(questions[0]!, mint);
          card.takesWords = true;
        }
      }
    } else {
      // The deciding part is capped well under Telegram's limit, so the card always fits.
      const formatted = formatApprovalCard(p.card, how.approvalHeadline);
      card.html = formatted.html;
      const buttons = [
        ...(formatted.allow ? [{ text: "Allow", callback_data: mint({ op: "allow" }) }] : []),
        { text: "Deny", callback_data: mint({ op: "deny" }) },
      ];
      rows = () => [buttons];
    }
    // A card that gives up by itself says when, worked out as it goes out (it may have waited in quiet hours).
    if (p.card.expiresAt) card.html += `\n\n${expiryLine(p.card.expiresAt, this.deps.now())}`;
    card.html += inlineLink;
    card.view = () => {
      const html = stepHtml ? stepHtml() + inlineLink : card.html;
      return card.linkRefused ? { html: html + linkText, rows: rows() } : { html, rows: [...rows(), ...linkRow] };
    };
    const first = card.view();
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html: first.html,
      markup: { inline_keyboard: first.rows },
      ...(link.button ? { fallbackHtml: first.html + linkText } : {}),
    }, {
      label: "approval card",
      silent: () => !how.askedOnPhone && (this.deps.silence?.inPpm() ?? false),
      onSent: (sent, info) => {
        card.messageId = sent.message_id;
        // Every card here waits on a decision: sent silently, it gets one reminder if nobody answers.
        if (info.silent) {
          this.deps.reminders?.schedule({
            chatId, messageId: sent.message_id, label: "approval card",
            stillWaiting: () => !card.done && this.cards.get(key) === card,
          });
        }
        // Sent again without its link button: every later step has to leave the button out too.
        if (link.button && !sent.reply_markup?.inline_keyboard.flat().some((b) => b.url)) card.linkRefused = true;
        try { how.onSent?.(sent.message_id); } catch (e) { log.warn(`card ${card.requestId}: ${(e as Error).message}`); }
        if (card.done) this.finish(card);
        else {
          this.deps.state.add(chatId, "cards", sent.message_id);
          // Pressed on before Telegram said the message was there: it still shows the first step.
          if (card.wizard && (card.wizard.step > 0 || card.selection.size > 0)) this.redraw(card);
        }
      },
      onDropped: () => { this.cards.delete(key); this.deps.codes.dropGroup(group); },
    }));
  }

  resolved(p: ChatLifecycleEvents["approval_resolved"]): void {
    for (const card of [...this.cards.values()]) {
      if (card.requestId !== p.requestId || card.done) continue;
      card.done = true;
      card.endLine = resolutionLine(p, card.isQuestion);
      this.deps.codes.dropGroup(card.group);
      this.finish(card);
      if (p.reason === "expired") this.sayExpired(card);
    }
  }

  /**
   * One line under a card that ran out: an edit does not buzz the phone, and the user should learn
   * that what they were asked about did not happen. Not in quiet hours, like any other reminder.
   */
  private sayExpired(card: ShownCard): void {
    if (card.messageId === null || inQuietHours()) return;
    this.deps.queue.enqueue(card.chatId, sendMessageTask(this.deps.queue, card.chatId, {
      html: expiredNoticeHtml(card.headline), replyTo: card.messageId,
    }, { label: "card expired", silent: () => this.deps.silence?.inPpm() ?? false }));
  }

  forgetChat(chatId: string): void {
    for (const [key, card] of this.cards) if (card.chatId === chatId) this.cards.delete(key);
    this.armed.forget(chatId);
  }

  /** The chat's next message is meant for something else now (a task's chat): it stops waiting for a typed answer. */
  stopTyped(chatId: string): void {
    this.armed.end(chatId, "elsewhere");
  }

  press(chatId: string, press: CardPress, group: string, _cq: TelegramCallbackQuery): string {
    const card = this.cards.get(`${chatId}|${press.requestId}`);
    if (!card || card.done || card.group !== group || card.sessionId !== press.sessionId) {
      this.deps.codes.dropGroup(group);
      return "This card is no longer waiting.";
    }
    if (press.op === "other") return this.armOther(card, press.questionId);
    if (press.op === "other_cancel") {
      const armed = this.armed.get(chatId, this.deps.now());
      if (armed?.cardKey !== keyOf(card)) return "Not waiting for an answer to this card.";
      this.armed.end(chatId, "cancelled");
      return "Cancelled. Your next message goes to the Assistant.";
    }
    // Any other button on the card (a choice, Back, Next, Send) ends a wait for words to it: the
    // next message must not answer a question the user has just answered, or left, with a button.
    this.armed.endCard(keyOf(card), card.wizard && press.op !== "send" ? "moved" : "ended");
    if (card.wizard && press.op !== "send" && press.op !== "allow" && press.op !== "deny") return this.step(card, card.wizard, press);
    if (press.op === "toggle" || press.op === "next" || press.op === "back") return "This button is no longer valid.";
    if (press.op === "send" && card.wizard?.step !== card.questions.length) {
      if (card.wizard) this.redraw(card);
      return EARLIER_STEP;
    }
    let answer: { approved: boolean; answersById?: AnswersById };
    if (press.op === "allow" || press.op === "deny") {
      answer = { approved: press.op === "allow" };
    } else {
      const byId: AnswersById = press.op === "pick" && press.questionId && press.option
        ? { [press.questionId]: [press.option] }
        : Object.fromEntries(card.selection);
      const error = answersByIdError(card.questions, byId, { requireAll: true });
      if (error) return error.slice(0, 180);
      answer = { approved: true, answersById: byId };
    }
    if (!this.answer(card, answer)) return "This card is no longer waiting.";
    return press.op === "deny" ? "Denied." : press.op === "allow" ? "Allowed." : "Answer sent.";
  }

  /** Answers the chat the card waits on; false when nothing waits on it any more (the card then says so). */
  private answer(card: ShownCard, answer: { approved: boolean; answersById?: AnswersById }): boolean {
    this.deps.codes.dropGroup(card.group);
    this.armed.endCard(keyOf(card), "ended");
    const result = chatControl()?.answerApproval(card.sessionId, card.requestId, answer, "telegram") ?? "stale";
    if (result === "stale" && !card.done) {
      card.done = true;
      card.endLine = "<i>No longer waiting.</i>";
      this.finish(card);
      return false;
    }
    return true;
  }

  /**
   * "✏️ Other" on a question: the chat's next message answers it. Says so on a line of its own,
   * under the card, with Cancel. On a card asked step by step only the question on screen can be armed.
   */
  private armOther(card: ShownCard, questionId: string | undefined): string {
    const q = card.questions.find((x) => x.id === questionId);
    if (!q || !card.takesWords || !q.allowsFreeText || needsPpm(q)) return "This button is no longer valid.";
    if (card.wizard && card.questions[card.wizard.step]?.id !== q.id) {
      this.redraw(card);
      return EARLIER_STEP;
    }
    this.deps.codes.touchGroup(card.group);
    const now = this.deps.now();
    const armed: ArmedAnswer = { cardKey: keyOf(card), questionId: q.id, until: now + TYPED_ANSWER_WINDOW_MS, promptMessageId: null, promptHead: typedPromptHead(q) };
    this.armed.arm(card.chatId, armed, now);
    const cancel = this.deps.codes.mint(card.chatId, card.group, {
      kind: "card", sessionId: card.sessionId, requestId: card.requestId, op: "other_cancel", questionId: q.id,
    });
    this.deps.queue.enqueue(card.chatId, sendMessageTask(this.deps.queue, card.chatId, {
      html: typedPromptHtml(q),
      markup: { inline_keyboard: [[{ text: "Cancel", callback_data: cancel }]] },
      ...(card.messageId !== null ? { replyTo: card.messageId } : {}),
    }, {
      label: "typed answer prompt",
      onSent: (sent) => {
        armed.promptMessageId = sent.message_id;
        // The wait ended while the line was on its way: it says so at once.
        if (armed.endedWhy) this.closePrompt(card.chatId, armed);
      },
    }));
    return "Type your answer and send it.";
  }

  /** Edits a "type your answer" line whose wait ended: the question stays, Cancel goes, a line says why. */
  private closePrompt(chatId: string, waited: ArmedAnswer): void {
    const messageId = waited.promptMessageId;
    if (messageId === null || !waited.endedWhy) return;
    const html = promptEndedHtml(waited.promptHead, waited.endedWhy);
    let attempts = 0;
    this.deps.queue.enqueue(chatId, {
      final: true, label: "typed answer prompt ended",
      run: async (client) => outcomeOf(await client.editMessageText(chatId, messageId, html, { final: true }), ++attempts),
    });
  }

  /**
   * A message that may be words for a question card: a reply to the card (or to its "type your
   * answer" line), or the next message after Other. Returns what to tell the user when the card took
   * it (or refused it), and null when it is not for a card here — the message then goes on as usual.
   *
   * A plain reply the card cannot take as the answer (a photo, a question taking choices only, a card
   * shown without buttons, the summary of a card asked step by step) is left alone: it goes on to the
   * chat word for word, as replies to a card always did. Only after Other is a message refused here.
   */
  typed(chatId: string, m: TypedAnswerMessage): string | null {
    if (m.notTheUsers) return null;
    const armed = this.armed.get(chatId, this.deps.now());
    let card: ShownCard | undefined;
    if (m.replyToMessageId !== undefined) {
      const to = m.replyToMessageId;
      card = [...this.cards.values()].find((c) => c.chatId === chatId && c.isQuestion && !c.done
        && (c.messageId === to || (armed?.cardKey === keyOf(c) && armed.promptMessageId === to)));
    } else if (armed) {
      card = this.cards.get(armed.cardKey);
    }
    if (!card || card.done) {
      if (card) this.armed.endCard(keyOf(card), "ended");
      return null;
    }
    const viaOther = armed?.cardKey === keyOf(card);
    const text = m.text.trim();
    const q = card.wizard ? card.questions[card.wizard.step] : card.questions[0];
    if (!viaOther) {
      if (m.hasPhoto || !text || !card.takesWords || !q?.allowsFreeText || needsPpm(q)) return null;
    } else {
      if (m.hasPhoto) return "Send your answer as text, without a photo.";
      if (!text) return "Send your answer as text.";
    }
    if (card.wizard) {
      this.deps.codes.touchGroup(card.group);
      const r = applyTypedAnswer(card.questions, card.wizard, card.selection, viaOther ? armed!.questionId : null, text);
      if (viaOther) this.armed.end(chatId, r.taken ? "answered" : "moved");
      if (r.redraw) this.redraw(card);
      return escapeTelegramHtml(r.toast);
    }
    const byId: AnswersById = { [q!.id]: [text] };
    const error = answersByIdError(card.questions, byId, { requireAll: true });
    if (error) return escapeTelegramHtml(error.slice(0, 180));
    if (viaOther) this.armed.end(chatId, "answered");
    return this.answer(card, { approved: true, answersById: byId }) ? answerSentHtml(text) : "This card is no longer waiting.";
  }

  /**
   * A press on a step-by-step card that does not answer it: records a choice or moves between
   * questions (`applyWizardPress`), then redraws the message — also after a press left over from
   * another step, which changes nothing but says the message is behind the card.
   */
  private step(card: ShownCard, wizard: WizardState, press: CardPress): string {
    // A card in use keeps its buttons longest when the code store is full.
    this.deps.codes.touchGroup(card.group);
    const { toast, redraw } = applyWizardPress(card.questions, wizard, card.selection, press);
    if (redraw) this.redraw(card);
    return toast;
  }

  /**
   * Edits the card's message to its current step. Queued under one key per card, so presses
   * faster than Telegram takes edits become one edit, drawn from the card as it is when it runs.
   */
  private redraw(card: ShownCard): void {
    const messageId = card.messageId;
    if (messageId === null) return;
    let attempts = 0;
    this.deps.queue.enqueue(card.chatId, {
      key: `step:${card.group}`, final: true, label: "question step",
      run: async (client: TelegramBotClient) => {
        if (card.done) return { kind: "done" };
        const view = card.view();
        const res = await client.editMessageText(card.chatId, messageId, view.html, { replyMarkup: { inline_keyboard: view.rows } });
        if (!res.ok && !("throttled" in res) && res.errorCode === 400 && BUTTON_URL_INVALID.test(res.description) && !card.linkRefused) {
          card.linkRefused = true;
          return { kind: "retry", afterMs: EDIT_INTERVAL_MS, why: "link button refused" };
        }
        return outcomeOf(res, ++attempts);
      },
      // Refused for good, or failing past the deadline: buttons that no longer match what the
      // message says would only answer "from an earlier step", so the card ends here instead.
      onDropped: () => this.giveUp(card),
    });
  }

  /** Ends a card on Telegram that cannot be kept up to date there; it still waits in PPM. */
  private giveUp(card: ShownCard): void {
    if (card.done) return;
    card.done = true;
    card.endLine = "<i>This card could not be updated here — answer it in PPM.</i>";
    this.deps.codes.dropGroup(card.group);
    this.finish(card);
  }

  /** Takes the card's buttons away and says why it is no longer waiting (once it was sent). */
  private finish(card: ShownCard): void {
    const messageId = card.messageId;
    this.armed.endCard(keyOf(card), "ended");
    if (messageId === null) return;
    this.cards.delete(keyOf(card));
    const html = card.endLine ? `${card.html}\n\n${card.endLine}` : card.html;
    let attempts = 0;
    this.deps.queue.enqueue(card.chatId, {
      final: true, label: "card result",
      run: async (client) => {
        // An edit without a keyboard takes the buttons away.
        const res = await client.editMessageText(card.chatId, messageId, html, { final: true });
        if (res.ok) this.deps.state.remove(card.chatId, "cards", messageId);
        return outcomeOf(res, ++attempts);
      },
    });
  }
}

/** Where a card is kept: one per chat and request. */
const keyOf = (card: Pick<ShownCard, "chatId" | "requestId">): string => `${card.chatId}|${card.requestId}`;

/**
 * One question with one choice: a button per option answers it at once, and "✏️ Other" (the only
 * button when there are no options) takes the user's next message as the answer.
 */
function singlePickRows(q: NormalizedQuestion, mint: Mint): () => InlineKeyboardButton[][] {
  const rows = q.options.map((o) => [{ text: buttonLabel(o.label), callback_data: mint({ op: "pick", questionId: q.id, option: o.label }) }]);
  if (q.allowsFreeText) rows.push([{ text: otherButtonLabel(q), callback_data: mint({ op: "other", questionId: q.id }) }]);
  return () => rows;
}

/** What Telegram counts against its limit: the text after the markup is parsed. */
function visibleLength(html: string): number {
  return stripTelegramHtml(html).length;
}
