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
 * every button of that card; a question with several choices keeps its buttons while choices are
 * ticked, until Send.
 */
import { chatControl, type LiveApprovalCard } from "../chat-control/chat-control.ts";
import type { ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { answersByIdError, type AnswersById, type NormalizedQuestion } from "../../shared/approval-questions.ts";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/telegram-types.ts";
import { redactForTelegram, stripTelegramHtml } from "../telegram/telegram-html-format.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import type { CardPress } from "./assistant-telegram-actions.ts";
import type { BridgeCards, BridgeDeps } from "./assistant-telegram.service.ts";
import { formatApprovalCard, formatQuestionCard, needsPpm, resolutionLine } from "./assistant-telegram-card-format.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { outcomeOf, sendMessageTask } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** Room left under Telegram's 4096 for the link line under a card. */
const CARD_VISIBLE_MAX = 3900;
const LABEL_MAX = 60;
const CARD_TITLE_MAX = 80;

/** A card of a chat other than the Assistant's own, and where that chat lives. */
export interface RelayedCard {
  targetSessionId: string;
  targetProject: string;
  targetProvider: string;
  targetTitle: string;
  card: LiveApprovalCard;
}

/** What a card is, whoever's it is. */
type CardSource = Pick<ChatLifecycleEvents["approval_shown"], "sessionId" | "providerId" | "card">;

/** How a card is introduced, and where its Open in PPM goes. */
interface CardPresentation {
  approvalHeadline: string;
  questionHeadline: string;
  link: () => Promise<string>;
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
  html: string;
  isQuestion: boolean;
  questions: NormalizedQuestion[];
  /** Ticked choices of a card answered with Send. */
  selection: Map<string, string[]>;
  /** The buttons as last sent, rebuilt when a tick changes. */
  rows: (selection: Map<string, string[]>) => InlineKeyboardButton[][];
  messageId: number | null;
  done: boolean;
  /** Why it is no longer waiting, shown under it once it is done. */
  endLine: string | null;
}

/** A button's text: plain, so not escaped, but redacted like everything else sent. */
const label = (raw: string) => {
  const s = redactForTelegram(raw);
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;
};

export class AssistantTelegramCards implements BridgeCards {
  private readonly cards = new Map<string, ShownCard>();

  constructor(private readonly deps: BridgeDeps) {}

  shown(chatId: string, p: ChatLifecycleEvents["approval_shown"]): void {
    this.showSafely(chatId, p, {
      approvalHeadline: "PPM Assistant wants to",
      questionHeadline: "PPM Assistant asks",
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
      approvalHeadline: `Chat ${where} needs your decision`,
      questionHeadline: `Chat ${where} asks`,
      link: () => this.deps.chatLink(p.targetProject, p.targetProvider, p.targetSessionId),
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
      questions, selection: new Map(), rows: () => [], messageId: null, done: false, endLine: null,
    };
    // Registered before the link is looked up, so a card answered meanwhile is known to be done.
    this.cards.set(key, card);
    const link = placeLink(await how.link());
    if (card.done) {
      this.cards.delete(key);
      return;
    }
    const mint = (press: Omit<CardPress, "kind" | "sessionId" | "requestId">) =>
      this.deps.codes.mint(chatId, group, { kind: "card", sessionId: p.sessionId, requestId: p.card.requestId, ...press });

    let rows: ShownCard["rows"] = () => [];
    if (card.isQuestion) {
      card.html = formatQuestionCard(questions, how.questionHeadline);
      if (visibleLength(card.html) > CARD_VISIBLE_MAX) card.html = `❓ <b>${escapeTelegramHtml(how.questionHeadline)}</b>\nThis question is too long to show here — answer it in PPM.`;
      else if (questions.length > 0 && !questions.some(needsPpm)) rows = questionRows(questions, mint);
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
    if (link.inline) card.html += `\n\n${link.inline}`;
    const linkRow = link.button ? [[link.button]] : [];
    card.rows = (selection) => [...rows(selection), ...linkRow];
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html: card.html,
      markup: { inline_keyboard: card.rows(card.selection) },
      // Telegram refusing the link as a button: the link goes in the text instead.
      ...(link.button ? { fallbackHtml: `${card.html}\n\n${escapeTelegramHtml(link.button.text)}: ${escapeTelegramHtml(link.button.url!)}` } : {}),
    }, {
      label: "approval card",
      onSent: (sent) => {
        card.messageId = sent.message_id;
        if (card.done) this.finish(card);
        else this.deps.state.add(chatId, "cards", sent.message_id);
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
    }
  }

  forgetChat(chatId: string): void {
    for (const [key, card] of this.cards) if (card.chatId === chatId) this.cards.delete(key);
  }

  press(chatId: string, press: CardPress, group: string, _cq: TelegramCallbackQuery): string {
    const card = this.cards.get(`${chatId}|${press.requestId}`);
    if (!card || card.done || card.group !== group || card.sessionId !== press.sessionId) {
      this.deps.codes.dropGroup(group);
      return "This card is no longer waiting.";
    }
    if (press.op === "toggle") return this.toggle(card, press);
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
    this.deps.codes.dropGroup(group);
    const result = chatControl()?.answerApproval(card.sessionId, card.requestId, answer, "telegram") ?? "stale";
    if (result === "stale" && !card.done) {
      card.done = true;
      card.endLine = "<i>No longer waiting.</i>";
      this.finish(card);
      return "This card is no longer waiting.";
    }
    return press.op === "deny" ? "Denied." : press.op === "allow" ? "Allowed." : "Answer sent.";
  }

  private toggle(card: ShownCard, press: CardPress): string {
    const q = card.questions.find((x) => x.id === press.questionId);
    if (!q || !press.option) return "This button is no longer valid.";
    const now = card.selection.get(q.id) ?? [];
    const on = !now.includes(press.option);
    const next = q.multiSelect ? (on ? [...now, press.option] : now.filter((o) => o !== press.option)) : on ? [press.option] : [];
    if (next.length) card.selection.set(q.id, next);
    else card.selection.delete(q.id);
    const messageId = card.messageId;
    if (messageId !== null) {
      const markup = { inline_keyboard: card.rows(card.selection) };
      this.deps.queue.enqueue(card.chatId, {
        key: `ticks:${card.group}`, final: false, label: "card ticks",
        run: async (client) => {
          if (card.done) return { kind: "done" };
          const res = await client.editMessageReplyMarkup(card.chatId, messageId, markup);
          return res.ok ? { kind: "done" } : { kind: "failed", why: `${res.errorCode} ${res.description}` };
        },
      });
    }
    return on ? "Ticked." : "Unticked.";
  }

  /** Takes the card's buttons away and says why it is no longer waiting (once it was sent). */
  private finish(card: ShownCard): void {
    const messageId = card.messageId;
    if (messageId === null) return;
    this.cards.delete(`${card.chatId}|${card.requestId}`);
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

type Mint = (press: Omit<CardPress, "kind" | "sessionId" | "requestId">) => string;

/**
 * One question with one choice: a button per option answers at once. Anything else: buttons
 * tick choices (✓) and Send answers them all, so nothing is sent half-answered.
 */
function questionRows(questions: readonly NormalizedQuestion[], mint: Mint): (s: Map<string, string[]>) => InlineKeyboardButton[][] {
  if (questions.length === 1 && !questions[0]!.multiSelect) {
    const q = questions[0]!;
    const rows = q.options.map((o) => [{ text: label(o.label), callback_data: mint({ op: "pick", questionId: q.id, option: o.label }) }]);
    return () => rows;
  }
  const codes = questions.map((q) => q.options.map((o) => ({ q, o, data: mint({ op: "toggle", questionId: q.id, option: o.label }) })));
  const send = mint({ op: "send" });
  return (selection) => [
    ...codes.flat().map(({ q, o, data }) => [{
      text: `${selection.get(q.id)?.includes(o.label) ? "✓ " : ""}${questions.length > 1 ? `${label(q.header ?? q.id)}: ` : ""}${label(o.label)}`,
      callback_data: data,
    }]),
    [{ text: "Send", callback_data: send }],
  ];
}

/** What Telegram counts against its limit: the text after the markup is parsed. */
function visibleLength(html: string): number {
  return stripTelegramHtml(html).length;
}
