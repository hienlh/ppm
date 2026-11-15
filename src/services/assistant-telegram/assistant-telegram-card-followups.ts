/**
 * The manager's answer to a card reply, on Telegram: a message threaded under the card's message.
 *
 * - **Replied on Telegram**: answered in that chat, under the card the user replied to. Within
 *   {@link CARD_FOLLOWUP_LOUD_MS} of the reply it rings whatever the hour: the user is holding the
 *   phone and waiting, so neither "quiet while I'm at PPM" nor quiet hours apply — the same as the
 *   answer to anything typed on Telegram. A later answer (the reply started a long task) still
 *   comes, but silently while the user is at PPM or in quiet hours.
 * - **Replied in PPM**: the answer is under the card there already. A card that also went to
 *   Telegram gets it under each of its copies too, following that card's rules: silent while the
 *   user is at PPM, and not sent at all during quiet hours (they replied in PPM; nothing waits on
 *   the phone, so nothing is saved up for the morning).
 * - **The turn was stopped** (Stop, an error) before it answered: a Telegram reply gets one line
 *   saying so, with the link; a PPM reply gets nothing.
 *
 * Every send goes through the bridge's lane for that chat and its access check, like a card.
 */
import { getSessionProvider } from "../db.service.ts";
import { projectTelegramDetail } from "../assistant-managers/manager-chats-db.ts";
import { getCardRow, type TelegramCardRef } from "../assistant-cards/assistant-cards-db.ts";
import { addCardTelegramRef } from "../assistant-cards/assistant-cards-outbound-db.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { CARD_FOLLOWUP_LOUD_MS } from "../../shared/assistant-limits.ts";
import type { CardFollowupDelivery, CardFollowupSink } from "../assistant-cards/card-reply-followup.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { createLogger } from "../logger.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import type { CardDetail } from "./assistant-telegram-card-kinds.ts";
import { formatCardFollowup } from "./assistant-telegram-followup-format.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { TelegramSilence } from "./assistant-telegram-silence.ts";

const log = createLogger("assistant-telegram");

export interface CardFollowupsDeps {
  queue: AssistantTelegramSendQueue;
  chatLink: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
  silence?: TelegramSilence;
  /** The card's messages on Telegram, as (chat, message) pairs; `followUp` marks an earlier answer. */
  refsOf?: (cardId: string) => TelegramCardRef[];
  /** Records a sent follow-up as one of the card's messages, so a reply to it reaches the manager. */
  recordRef?: (cardId: string, ref: TelegramCardRef) => void;
  detailOf?: (card: AssistantCard) => CardDetail;
  /** When the quiet window now running ends; null outside quiet hours. */
  quietEnd?: () => number | null;
  canSend?: (chatId: string) => boolean;
  /** The clock the reply's time was taken on (the Assistant's). */
  now?: () => number;
}

interface Target { chatId: string; replyTo?: number; silent: () => boolean }

/** As a card is shown: a project PPM has no setting for keeps its details off the phone. */
function realDetail(card: AssistantCard): CardDetail {
  if (!card.projectKey) return "full";
  return projectTelegramDetail(card.projectKey) ?? "title";
}

export class AssistantTelegramCardFollowups implements CardFollowupSink {
  constructor(private readonly deps: CardFollowupsDeps) {}

  /** The card's own copies: an earlier follow-up is an answer, never a copy to answer under. */
  private refs(cardId: string): TelegramCardRef[] {
    try { return (this.deps.refsOf ?? ((id) => getCardRow(id)?.telegramRefs ?? []))(cardId).filter((r) => !r.followUp); } catch { return []; }
  }

  private quiet(): boolean {
    try { return (this.deps.quietEnd ?? currentQuietWindowEnd)() !== null; } catch { return false; }
  }

  /** Who gets the answer, under which message, and whether without a sound. */
  targets(d: CardFollowupDelivery): Target[] {
    const canSend = this.deps.canSend ?? canSendTo;
    const refs = this.refs(d.card.id);
    if (d.origin.channel === "telegram") {
      const { chatId } = d.origin;
      const replyTo = d.origin.replyTo ?? refs.find((r) => r.chatId === chatId)?.messageId;
      const now = (this.deps.now ?? (() => assistantClock.now()))();
      // Held phone, minutes not hours: a late answer follows the quiet rules, but still arrives,
      // silently, since the user asked on the phone and is waiting there.
      const loud = now - d.repliedAt <= CARD_FOLLOWUP_LOUD_MS;
      const silent = loud ? () => false : () => this.quiet() || (this.deps.silence?.inPpm() ?? false);
      return canSend(chatId) ? [{ chatId, ...(replyTo ? { replyTo } : {}), silent }] : [];
    }
    // A stopped turn is said only to a reply typed on Telegram; a PPM reply has the chat at hand.
    if (refs.length === 0 || d.stopped) return [];
    if (this.quiet()) {
      log.info(`card ${d.card.id}: the manager's answer stays in PPM (quiet hours)`);
      return [];
    }
    const silent = () => this.deps.silence?.inPpm() ?? false;
    const seen = new Set<string>();
    return refs.filter((r) => canSend(r.chatId) && !seen.has(r.chatId) && seen.add(r.chatId))
      .map((r) => ({ chatId: r.chatId, replyTo: r.messageId, silent }));
  }

  send(d: CardFollowupDelivery): void {
    const targets = this.targets(d);
    if (targets.length === 0) return;
    void this.sendTo(d, targets).catch((e) => log.warn(`card ${d.card.id}: answer not sent to Telegram: ${(e as Error).message}`));
  }

  private async sendTo(d: CardFollowupDelivery, targets: Target[]): Promise<void> {
    const project = d.card.projectName ?? null;
    const url = project
      ? await this.deps.chatLink(project, getSessionProvider(d.sessionId), d.sessionId).catch(() => null)
      : null;
    let detail: CardDetail = "title";
    try { detail = (this.deps.detailOf ?? realDetail)(d.card); } catch { /* unknown: the safe side */ }
    const formatted = formatCardFollowup({
      text: d.text, overflow: d.overflow, detail, projectName: project, newCards: d.newCards, url, ...(d.stopped ? { stopped: true } : {}),
    });
    const record = this.deps.recordRef ?? addCardTelegramRef;
    for (const t of targets) {
      this.deps.queue.enqueue(t.chatId, sendMessageTask(this.deps.queue, t.chatId, {
        html: formatted.html,
        ...(t.replyTo ? { replyTo: t.replyTo } : {}),
        ...(formatted.markup ? { markup: formatted.markup } : {}),
        ...(formatted.fallbackHtml ? { fallbackHtml: formatted.fallbackHtml } : {}),
      }, {
        label: "card follow-up",
        silent: t.silent,
        // The answer reads like a conversation, so the natural reply is to it: that reply has to
        // reach the same manager, as a reply to the card does, not the Assistant.
        onSent: (sent) => {
          // With exactly one new card named, a bare OK to this answer is a yes to that card.
          const newCardId = d.newCards.length === 1 ? d.newCards[0]!.id : undefined;
          try { record(d.card.id, { chatId: t.chatId, messageId: sent.message_id, followUp: true, ...(newCardId ? { newCardId } : {}) }); } catch (e) {
            log.warn(`card ${d.card.id}: the follow-up's message was not recorded: ${(e as Error).message}`);
          }
        },
      }));
    }
  }
}
