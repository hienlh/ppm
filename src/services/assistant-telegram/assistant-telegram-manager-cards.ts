/**
 * The PPM Assistant's cards on Telegram: every connected chat gets each card the outbound gate
 * lets through (`card-outbound.ts`), formatted at the project's detail level, with its buttons
 * behind codes and its message ids recorded as (chat, message) pairs, which is how a reply to it is
 * found. When a card stops waiting, every copy loses its buttons and says how it ended.
 *
 * A manager chat's approval or question goes out as the relay's own card (the same Allow rule,
 * answering the manager chat directly), and that card ends itself when the request does.
 */
import { getCardRow, listOpenCardRows, type TelegramCardRef } from "../assistant-cards/assistant-cards-db.ts";
import { assistantCards } from "../assistant-cards/assistant-cards.service.ts";
import { primeTelegramPathLinks } from "../telegram/telegram-path-links.ts";
import { chatControl, type LiveApprovalCard } from "../chat-control/chat-control.ts";
import { getSessionProvider, getSessionTitle } from "../db.service.ts";
import { projectTelegramDetail } from "../assistant-managers/manager-chats-db.ts";
import { getMainSession } from "../assistant/assistant-main-session.ts";
import { addCardTelegramRef, setCardOutboundError } from "../assistant-cards/assistant-cards-outbound-db.ts";
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
import { formatNewCardPointer } from "./assistant-telegram-followup-format.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import { outcomeOf, sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { CardReminders, TelegramSilence } from "./assistant-telegram-silence.ts";
import { createLogger } from "../logger.ts";
import { WAITING_CARD_KINDS } from "../../shared/assistant-cards.ts";
import type { AssistantTelegramCardsDesk } from "./assistant-telegram-cards-desk.ts";
import { cardIcon } from "./assistant-telegram-card-kinds.ts";
import { repliesBeingAnswered } from "../assistant-cards/replies-being-answered.ts";
import { isAnswerCard, type AnsweredReply } from "../assistant-cards/card-reply-followup-tracker.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { CARD_FOLLOWUP_LOUD_MS } from "../../shared/assistant-limits.ts";
import { cardForTelegram, taskCardExtras, taskCardRows, type TaskCardExtras } from "./assistant-telegram-task-card-extras.ts";
import { isLinkOnlyCard, waitingNoticeHtml, type WaitingNoticeKind } from "./assistant-telegram-waiting-notices.ts";

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
  /** The replies a turn of this chat is answering now: card replies and task words (`repliesBeingAnswered`). */
  answering?: (sessionId: string | null) => AnsweredReply[];
  /** The clock the reply's time was taken on (the Assistant's). */
  now?: () => number;
  /** The pinned card desk: every card here that waits on the user is listed there too. */
  desk?: AssistantTelegramCardsDesk;
}

/** Under which message a card goes in one chat, and whether it rings whatever else holds. */
interface Thread { replyTo: number; loud: boolean }

const groupOf = (cardId: string, chatId: string): string => `mcard:${cardId}:${chatId}`;
/** A card's place on the pinned card desk. */
export const mcardDeskKey = (cardId: string): string => `mcard:${cardId}`;

/** A card that waits on the user (not a "done" or "failed" report, a digest or a rules note). */
function waitsOnUser(card: AssistantCard): boolean {
  return card.status === "open" && WAITING_CARD_KINDS.includes(card.kind);
}
const MAX_THREADED = 500;

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
  /**
   * "card\nchat" for each card sent into a chat as the answer to the user's reply there, and
   * whether the follow-up has asked about it already (it then sent nothing, counting on the card).
   */
  private readonly threaded = new Map<string, { asked: boolean }>();

  constructor(private readonly deps: ManagerCardsDeps) {}

  /**
   * Whether this card went to this chat under the user's reply: then it is the manager's whole
   * answer there, and the follow-up sends nothing (`assistant-telegram-card-followups.ts`).
   */
  threadedIn(cardId: string, chatId: string): boolean {
    const mark = this.threaded.get(`${cardId}\n${chatId}`);
    if (!mark) return false;
    mark.asked = true;
    return true;
  }

  /**
   * Per chat, the user's message a card answers. A card the manager opens while its turn answers a
   * reply typed on Telegram goes in that chat as a reply to the user's own message (to the card's
   * message they replied to when theirs is unknown), so the answer reads as one, and rings while
   * they are likely still holding the phone — like the follow-up it replaces. Asked when the card
   * is handed over, before anything awaits: the reply is forgotten once its turn ends.
   */
  private threadsOf(card: AssistantCard): Map<string, Thread> {
    const threads = new Map<string, Thread>();
    if (card.kind === "approval" || card.kind === "question" || !isAnswerCard(card)) return threads;
    let answering: AnsweredReply[];
    try { answering = (this.deps.answering ?? repliesBeingAnswered)(card.sessionId); } catch { return threads; }
    const now = (this.deps.now ?? (() => assistantClock.now()))();
    for (const a of answering) {
      if (a.origin.channel !== "telegram" || threads.has(a.origin.chatId)) continue;
      // Only a card made after the reply answers it: one held overnight, or sent again, that goes
      // out while a later reply's turn runs is not its answer.
      if (card.createdAt < a.repliedAt) continue;
      const replyTo = a.origin.messageId ?? a.origin.replyTo;
      if (replyTo) threads.set(a.origin.chatId, { replyTo, loud: now - a.repliedAt <= CARD_FOLLOWUP_LOUD_MS });
    }
    return threads;
  }

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
    const chats = this.recipients();
    if (!chats.length) return;
    const threads = cards.map((c) => this.threadsOf(c));
    // Marked now, before the link is awaited: the turn may end first, and its follow-up must know.
    cards.forEach((card, i) => {
      for (const chatId of threads[i]!.keys()) if (chats.includes(chatId)) this.threaded.set(`${card.id}\n${chatId}`, { asked: false });
    });
    // Asked only until the turn's follow-up is sent, so the oldest marks can go.
    while (this.threaded.size > MAX_THREADED) this.threaded.delete(this.threaded.keys().next().value!);
    void this.sendAll(cards, chats, threads, header).catch((e) => log.warn(`cards not sent to Telegram: ${(e as Error).message}`));
  }

  private async sendAll(cards: AssistantCard[], chats: string[], threads: Array<Map<string, Thread>>, header?: string): Promise<void> {
    // Links first, so every chat's lane gets the header and the cards in order.
    const links = await Promise.all(cards.map((c) => this.linkFor(c).catch(() => null)));
    // Folder and file paths in a card's text become links into PPM's file browser once checked.
    await Promise.all(cards.map((c) => primeTelegramPathLinks(`${c.title}\n${c.body ?? ""}`)));
    // A task card's Open chat links and Undo buttons (PPM Tasks); null for every other card.
    const extras = await Promise.all(cards.map((c) => taskCardExtras(c, this.deps.chatLink).catch((e) => {
      log.warn(`card ${c.id}: its task buttons could not be made: ${(e as Error).message}`);
      return null;
    })));
    for (const chatId of chats) {
      if (header) this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: `<b>${escapeTelegramHtml(header)}</b>` }, { label: "away header", silent: () => this.silent() }));
      cards.forEach((card, i) => this.sendOne(
        chatId, card, links[i] ?? null, threads[i]!.get(chatId) ?? this.supersededThread(card, chatId), extras[i] ?? null,
      ));
    }
  }

  /**
   * A card that replaces earlier ones goes under the old card's message in this chat, so the two
   * read as one thread; it rings no louder for it. Null when no replaced card was shown here.
   */
  private supersededThread(card: AssistantCard, chatId: string): Thread | null {
    for (const old of card.payload.supersedes ?? []) {
      let refs: TelegramCardRef[] = [];
      try { refs = getCardRow(old.id)?.telegramRefs ?? []; } catch { continue; }
      const ref = refs.find((r) => r.chatId === chatId && !r.followUp);
      if (ref) return { replyTo: ref.messageId, loud: false };
    }
    return null;
  }

  private async linkFor(card: AssistantCard): Promise<string | null> {
    if (card.sessionId && card.projectName) {
      return this.deps.chatLink(card.projectName, getSessionProvider(card.sessionId), card.sessionId);
    }
    const main = getMainSession();
    return main ? this.deps.sessionLink(main.providerId, main.sessionId) : null;
  }

  private sendOne(chatId: string, card: AssistantCard, url: string | null, thread: Thread | null = null, extras: TaskCardExtras | null = null): void {
    const record = (messageId: number) => addCardTelegramRef(card.id, { chatId, messageId });
    const detail = this.detail(card);
    if (card.kind === "approval" || card.kind === "question") {
      // A Design chat's card and an MCP sign-in are told with a link and nothing to press.
      if (isLinkOnlyCard(card)) {
        this.sendNotice(chatId, card, url, card.payload.answerInPpm as WaitingNoticeKind, false);
        return;
      }
      // A `db_execute` or vault card already has its own notice on Telegram, with no buttons: it
      // takes a password typed into PPM (`assistant-telegram-db-notices.ts`).
      if (card.payload.answerInPpm) return;
      const requestId = card.payload.requestId;
      const live = card.sessionId && requestId ? (this.deps.liveCard ?? realLiveCard)(card.sessionId, requestId) : null;
      if (!live) {
        log.info(`card ${card.id}: not relayed to Telegram, its request is no longer in front of the chat`);
        return;
      }
      if (this.deps.isShowing(chatId, live.requestId)) {
        log.info(`card ${card.id}: already on Telegram chat ${chatId} through the relay`);
        return;
      }
      const chat = card.payload.chat;
      this.deps.relayCard(chatId, {
        targetSessionId: card.sessionId!, targetProject: card.projectName ?? "project",
        targetProvider: chat?.providerId ?? getSessionProvider(card.sessionId!) ?? "claude",
        targetTitle: chat ? chat.title : getSessionTitle(card.sessionId!) || "Manager",
        card: live, onSent: record, ...(chat ? {} : { manager: true }), ...(detail === "title" ? { titleOnly: card.title } : {}),
      });
      return;
    }
    const formatted = formatManagerCard(cardForTelegram(card), detail);
    const group = groupOf(card.id, chatId);
    // The pictures first, so the card to answer them on comes last; never for a title-only project.
    const photos = detail === "full"
      ? cardPhotosTask(chatId, card, { silent: () => card.kind !== "urgent" && this.silent() })
      : null;
    if (photos) this.deps.queue.enqueue(chatId, photos);
    const { html, rows, link } = this.message(chatId, card, formatted, url, extras);
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html,
      ...(rows.length ? { markup: { inline_keyboard: rows } } : {}),
      ...(link.button ? { fallbackHtml: `${html}\n\n${escapeTelegramHtml(link.button.text)}: ${escapeTelegramHtml(link.button.url!)}` } : {}),
      ...(thread ? { replyTo: thread.replyTo } : {}),
    }, {
      label: `${card.kind} card`,
      // An urgent card rings even while the user is at PPM: it is the one kind that asked to be heard.
      // So does the answer to a reply typed on the phone moments ago: the user is waiting for it.
      silent: () => card.kind !== "urgent" && !thread?.loud && this.silent(),
      onSent: (sent, info) => {
        record(sent.message_id);
        if (waitsOnUser(card)) this.putOnDesk(chatId, card, sent.message_id, { html, rows, group });
        // A decision sent silently gets one reminder if it is still open later.
        if (info.silent && card.kind === "needs_decision") {
          this.deps.reminders?.schedule({
            chatId, messageId: sent.message_id, label: `${card.kind} card`,
            stillWaiting: () => this.isOpen(card.id),
            // The title is the manager's own text: a vault value in it is replaced here too.
            project: card.projectName ?? null, title: turnSecretScrubber.scrub(card.title), url,
          });
        }
      },
      // Refused (a 400 is never retried), past its deadline or its chat gone: on record, not assumed sent.
      onDropped: (why) => {
        this.deps.codes.dropGroup(group);
        // Not on the phone after all. A follow-up still to come names it instead; one that already
        // counted on it sent nothing, so the line naming it goes now, under the user's reply.
        const key = `${card.id}\n${chatId}`;
        const mark = this.threaded.get(key);
        this.threaded.delete(key);
        if (mark?.asked && thread) {
          try { this.sendPointer(chatId, card, url, thread); } catch (e) { log.warn(`card ${card.id}: could not name it under the reply: ${(e as Error).message}`); }
        }
        try { setCardOutboundError(card.id, why, Date.now()); } catch (e) { log.warn(`card ${card.id}: could not record the failed send: ${(e as Error).message}`); }
      },
    }));
  }

  /** The one line naming a card that answered the user's reply but never reached the phone. */
  private sendPointer(chatId: string, card: AssistantCard, url: string | null, thread: Thread): void {
    // The title is the manager's own text: a vault value in it is replaced here, not only by the client.
    const formatted = formatNewCardPointer({
      projectName: card.projectName ?? null, newCards: [{ title: turnSecretScrubber.scrub(card.title) }], url,
    });
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html: formatted.html, replyTo: thread.replyTo,
      ...(formatted.markup ? { markup: formatted.markup } : {}),
      ...(formatted.fallbackHtml ? { fallbackHtml: formatted.fallbackHtml } : {}),
      // Rings like the card it stands for would have: the user may still be holding the phone.
    }, { label: "card pointer", silent: () => !thread.loud && this.silent() }));
  }

  /**
   * A card sent earlier has stood unanswered past `APPROVAL_OVERDUE_MS`: one message more, with a
   * sound whether or not the user is at PPM, linking to the chat.
   */
  overdue(card: AssistantCard): void {
    const chats = this.recipients();
    if (!chats.length) return;
    void this.linkFor(card).catch(() => null).then((url) => {
      for (const chatId of chats) this.sendNotice(chatId, card, url, "overdue", true);
    });
  }

  /** A message with no buttons about a chat waiting on a card (see `assistant-telegram-waiting-notices.ts`). */
  private sendNotice(chatId: string, card: AssistantCard, url: string | null, kind: WaitingNoticeKind, loud: boolean): void {
    const link = url ? placeLink(url) : {};
    let html = waitingNoticeHtml(card, kind);
    if (link.inline) html += `\n\n${link.inline}`;
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html,
      ...(link.button ? { markup: { inline_keyboard: [[link.button]] } } : {}),
      ...(link.button ? { fallbackHtml: `${html}\n\n${escapeTelegramHtml(link.button.text)}: ${escapeTelegramHtml(link.button.url!)}` } : {}),
    }, {
      label: `${kind} notice`,
      silent: () => !loud && this.silent(),
      // The reminder is not the card: its message is not one to rewrite when the card ends.
      onSent: (sent) => {
        if (kind === "overdue") return;
        addCardTelegramRef(card.id, { chatId, messageId: sent.message_id });
        if (waitsOnUser(card)) this.putOnDesk(chatId, card, sent.message_id, { html, rows: link.button ? [[link.button]] : [], group: null });
      },
    }));
  }

  /** A card's text and buttons for one chat, its codes minted in the card's group there. */
  private message(chatId: string, card: AssistantCard, formatted: ReturnType<typeof formatManagerCard>, url: string | null, extras: TaskCardExtras | null) {
    const group = groupOf(card.id, chatId);
    const keys = formatted.buttons.map((b) => ({
      op: b.op,
      key: {
        text: b.text,
        // The code stands for the action; the choice's id stays here, on the server.
        callback_data: this.deps.codes.mint(chatId, group, {
          kind: "mcard", cardId: card.id, op: b.op,
          ...(b.op === "ok" && card.payload.draft ? { draftSha256: card.payload.draft.sha256 } : {}),
          ...(b.op === "choose" && b.optionId ? { optionId: b.optionId } : {}),
          ...((b.op === "approve" || b.op === "revert") && card.payload.rulesHash ? { rulesHash: card.payload.rulesHash, projectName: card.projectName ?? "" } : {}),
        }),
      } satisfies InlineKeyboardButton,
    }));
    // One choice per row, so a long label is read whole; any other buttons share a row.
    const choiceRows = keys.filter((k) => k.op === "choose").map((k) => [k.key]);
    const row: InlineKeyboardButton[] = keys.filter((k) => k.op !== "choose").map((k) => k.key);
    const link = url ? placeLink(url) : {};
    let html = formatted.html;
    const tasks = extras ? taskCardRows(extras, card.id, chatId, formatted.html, this.deps.codes) : { rows: [], inline: [] };
    if (tasks.inline.length) html += `\n\n${tasks.inline.join("\n")}`;
    if (link.inline) html += `\n\n${link.inline}`;
    const rows = [...choiceRows, ...(row.length ? [row] : []), ...tasks.rows, ...(link.button ? [[link.button]] : [])];
    return { html, rows, link, group };
  }

  /**
   * After a restart: the open cards this chat was shown, back on the desk with fresh buttons (the
   * codes on their own messages died with the old process). Approvals and questions are not: their
   * request ended with the chat it waited in.
   */
  async restoreDesk(chatId: string): Promise<void> {
    const desk = this.deps.desk;
    if (!desk) return;
    for (const row of listOpenCardRows()) {
      const ref = row.telegramRefs.find((r) => r.chatId === chatId && !r.followUp);
      if (!ref || desk.has(chatId, mcardDeskKey(row.id))) continue;
      const card = assistantCards.toCard(row);
      if (!waitsOnUser(card) || card.kind === "approval" || card.kind === "question") continue;
      const url = await this.linkFor(card).catch(() => null);
      const extras = await taskCardExtras(card, this.deps.chatLink).catch(() => null);
      const shown = this.message(chatId, card, formatManagerCard(cardForTelegram(card), this.detail(card)), url, extras);
      this.putOnDesk(chatId, card, ref.messageId, shown);
    }
  }

  /** Lists the card on the desk with what its message shows, its own buttons included. */
  private putOnDesk(chatId: string, card: AssistantCard, messageId: number, shown: { html: string; rows: InlineKeyboardButton[][]; group: string | null }): void {
    this.deps.desk?.put(chatId, {
      key: mcardDeskKey(card.id), icon: cardIcon(card.kind), urgent: card.kind === "urgent",
      // The title is the manager's own text: a vault value in it is replaced here too.
      project: card.projectName ?? null, title: turnSecretScrubber.scrub(card.title), since: card.createdAt, messageId,
      stillWaiting: () => this.isOpen(card.id),
      view: () => ({ html: shown.html, rows: shown.rows }),
      groups: shown.group ? [shown.group] : [],
    });
  }

  changed(card: AssistantCard): void {
    this.deps.desk?.removeEverywhere(mcardDeskKey(card.id));
    // The relay's own cards end themselves when their request does; a notice is rewritten below.
    if ((card.kind === "approval" || card.kind === "question") && !isLinkOnlyCard(card)) return;
    // A follow-up message is the manager's answer to a reply, not a copy of the card: left as it is.
    const refs = (getCardRow(card.id)?.telegramRefs ?? []).filter((r) => !r.followUp);
    const body = isLinkOnlyCard(card)
      ? waitingNoticeHtml(card, card.payload.answerInPpm as WaitingNoticeKind)
      : formatManagerCard(cardForTelegram(card), this.detail(card)).html;
    const html = `${body}\n\n${cardEndLine(card)}`;
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
