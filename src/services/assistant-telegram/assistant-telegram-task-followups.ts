/**
 * The chat's answer to words the user sent it about a task from Telegram, as a reply to the user's
 * own message there (`task-words-followup.ts` decides when; this decides what it says).
 *
 * - **answered**: which chat answered and which task it is about, then the answer — redacted, its
 *   hidden characters shown, escaped before it is formatted, cut to one message with "see the chat"
 *   and an Open link. A title-only project gets no text: only that the chat answered, and the link.
 * - **answered with a card** (a manager's report): the card's title; the card itself reaches the
 *   phone the way every card does.
 * - **waiting on a card** (approval, question, or one only PPM's screen takes): said once, with the
 *   link, so the phone does not go quiet while the turn holds.
 * - **stopped / failed**: one line, the error's first line where the project shows details.
 * - **no written answer**, or **unclear** (another turn ran before PPM could tell which answered):
 *   said, with the link, rather than nothing.
 *
 * The project's detail level is read again when the message goes, not when the user wrote: a
 * project switched to titles only during a long turn shows no content.
 *
 * Like a card reply's answer it rings within `CARD_FOLLOWUP_LOUD_MS` of the user's message (they are
 * holding the phone) and comes silently later in quiet hours or while the user is at PPM. A reply to
 * it is about the same task, like a reply to a task card.
 */
import { CARD_FOLLOWUP_LOUD_MS } from "../../shared/assistant-limits.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";
import type { TaskFollowupContext, TaskFollowupDelivery, TaskFollowupSink } from "../assistant-cards/task-words-followup.ts";
import { truncateText } from "../notification-format.ts";
import { createLogger } from "../logger.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import { cleanTelegramText, type CardDetail } from "./assistant-telegram-card-kinds.ts";
import { taskDetail } from "./assistant-telegram-tasks-deck.ts";
import { formatCardFollowup, withLink, type FormattedFollowup } from "./assistant-telegram-followup-format.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { chatLabelHtml, taskLabelHtml } from "./assistant-telegram-task-message.ts";
import type { TelegramSilence } from "./assistant-telegram-silence.ts";

const log = createLogger("assistant-telegram");

const ERROR_MAX = 200;

/** "the alpha manager chat" / "the chat “Fix login” working on it" — capitalised to open a line. */
function chatName(c: TaskFollowupContext): string {
  const label = chatLabelHtml({ kind: c.chat.kind, chatTitle: c.chat.chatTitle, detail: c.chat.detail, target: { projectName: c.chat.projectName } });
  return label.replace(/^the /, "The ");
}

const task = (c: TaskFollowupContext): string => taskLabelHtml({ ref: c.taskRef.ref, title: c.taskRef.title });

const WAITING: Record<"approval" | "question" | "ppm", string> = {
  approval: "is waiting for your approval",
  question: "is waiting for your answer to a question",
  ppm: "is waiting for something only PPM's screen can take",
};

/** What the message says, for each kind of delivery. Pure, so the wording is tested apart from the bot. */
export function formatTaskFollowup(d: TaskFollowupDelivery, url: string | null): FormattedFollowup {
  const c = d.context;
  const who = chatName(c);
  switch (d.kind) {
    case "answer":
      if (!d.text.trim()) return withLink(`💬 ${who} finished its turn about ${task(c)} without a written answer; see the chat.`, url);
      return formatCardFollowup({
        text: d.text, overflow: d.overflow, detail: c.chat.detail, projectName: c.chat.projectName, url,
        labelHtml: `💬 <b>${who.replace(/<\/?b>/g, "")}</b> answered, about ${task(c)}:`,
        titleOnlyNote: "It answered; the details stay in PPM for this project.",
      });
    case "cards": {
      const counter = { hidden: 0 };
      const titles = d.cards.slice(0, 3).map((x) => `<b>${cleanTelegramText(x.title.replace(/\s+/g, " ").trim(), counter)}</b>`).join(", ");
      const more = d.cards.length > 3 ? ` <i>and ${d.cards.length - 3} more</i>` : "";
      return withLink(`↩ ${who} answered about ${task(c)} with a card: ${titles}${more}`, url);
    }
    case "waiting":
      return withLink(`⏳ ${who} ${WAITING[d.waitingFor]} before it can answer about ${task(c)}.`, url);
    case "stopped":
      return withLink(`⏹ <i>${who} was stopped before it answered about ${task(c)}.</i>`, url);
    case "unclear":
      return withLink(`↪ ${who} took your message about ${task(c)}; its answer is in the chat.`, url);
    case "failed": {
      // The error is the provider's words and may quote the task's content: none on a title-only project.
      const first = d.error.split("\n", 1)[0]!.trim();
      // Hidden characters shown, secrets redacted, then escaped (`cleanTelegramText`).
      const shown = c.chat.detail === "full" && first ? `: ${cleanTelegramText(truncateText(first, ERROR_MAX), { hidden: 0 })}` : ".";
      return withLink(`⚠️ ${who} stopped on an error before it answered about ${task(c)}${shown}`, url);
    }
  }
}

export interface TaskFollowupsDeps {
  queue: AssistantTelegramSendQueue;
  chatLink: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
  silence?: TelegramSilence;
  canSend?: (chatId: string) => boolean;
  quietEnd?: () => number | null;
  now?: () => number;
  /** The message just sent is about this task: a reply to it goes to the same chat. */
  remember?: (chatId: string, messageId: number, taskId: string) => void;
  /** The project's detail level now; unknown is the safe side, titles only. */
  detailOf?: (projectKey: string) => CardDetail;
  /** Whether this card went to this chat threaded under the user's message (the manager-card relay). */
  threadedIn?: (cardId: string, chatId: string) => boolean;
}

export class AssistantTelegramTaskFollowups implements TaskFollowupSink {
  constructor(private readonly deps: TaskFollowupsDeps) {}

  private quiet(): boolean {
    try { return (this.deps.quietEnd ?? currentQuietWindowEnd)() !== null; } catch { return false; }
  }

  send(d: TaskFollowupDelivery): void {
    const { chatId, messageId } = d.context.origin;
    if (!(this.deps.canSend ?? canSendTo)(chatId)) return;
    void this.sendTo(d, chatId, messageId).catch((e) => log.warn(`task ${d.context.taskRef.ref}: the chat's answer was not sent to Telegram: ${(e as Error).message}`));
  }

  private async sendTo(given: TaskFollowupDelivery, chatId: string, messageId: number): Promise<void> {
    let detail: CardDetail = "title";
    try { detail = (this.deps.detailOf ?? taskDetail)(given.context.chat.projectKey); } catch { /* unknown: the safe side */ }
    let d: TaskFollowupDelivery = { ...given, context: { ...given.context, chat: { ...given.context.chat, detail } } };
    if (d.kind === "cards") {
      // A card that went under the user's message is the answer itself: nothing more is said for it.
      const threaded = this.deps.threadedIn ?? (() => false);
      const left = d.cards.filter((c) => { try { return !threaded(c.id, chatId); } catch { return true; } });
      if (left.length === 0) return;
      d = { ...d, cards: left };
    }
    const url = await this.deps.chatLink(d.context.chat.projectName, d.context.chat.providerId, d.sessionId).catch(() => null);
    const formatted = formatTaskFollowup(d, url);
    const now = (this.deps.now ?? (() => assistantClock.now()))();
    const loud = now - d.repliedAt <= CARD_FOLLOWUP_LOUD_MS;
    const silent = loud ? () => false : () => this.quiet() || (this.deps.silence?.inPpm() ?? false);
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html: formatted.html, replyTo: messageId,
      ...(formatted.markup ? { markup: formatted.markup } : {}),
      ...(formatted.fallbackHtml ? { fallbackHtml: formatted.fallbackHtml } : {}),
    }, {
      label: "task chat answer",
      silent,
      onSent: (sent) => { try { this.deps.remember?.(chatId, sent.message_id, d.context.taskRef.taskId); } catch { /* best effort */ } },
    }));
    log.info(`task ${d.context.taskRef.ref}: ${d.kind} sent to Telegram chat ${chatId} under message ${messageId}`);
  }
}
