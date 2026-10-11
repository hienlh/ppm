/**
 * What a watch has to tell Telegram that the Assistant session's own conversation does not.
 *
 * - A watched chat put a card on its screen (`watch_decision`): the card goes to Telegram with
 *   buttons that answer that chat directly — no model turn, and the same Allow rule as every
 *   card. The watch is the user's request to hear about that chat, so it goes where they asked:
 *   to the Telegram chats bound to the Assistant session that set the watch, or, when none is,
 *   to every connected chat (the user asked somewhere they are not on their phone).
 * - A watch reported (`watch_reported`) from an Assistant session no Telegram chat talks to: its
 *   answer was only written in PPM, so every connected chat gets one line naming the chat.
 *   A bound session's report needs nothing here: it is a turn of that session, and the mirror
 *   already shows it in the bound chats.
 *
 * Recipients are worked out per event, from bindings and connections as they are then; the send
 * lane checks each chat again before every call.
 */
import { telegramChatsBoundTo } from "../assistant-hub/assistant-hub-db.ts";
import { watchEvents, type WatchEvents } from "../assistant-watch/watch-events.ts";
import { getSessionProvider } from "../db.service.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import type { WatchEventKind } from "../../types/chat.ts";
import { canSendTo, reachableChats } from "./assistant-telegram-access.ts";
import type { RelayedCard } from "./assistant-telegram-cards.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** How much of a watch report is repeated on Telegram. */
export const RELAYED_REPORT_MAX = 1500;
const TITLE_MAX = 80;

export interface RelayDeps {
  queue: AssistantTelegramSendQueue;
  /** Shows another chat's card in a Telegram chat. */
  relayCard: (chatId: string, card: RelayedCard) => void;
  /** The link that opens a chat in PPM. */
  chatLink: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
  boundChats?: (assistantSessionId: string) => string[];
  connectedChats?: () => string[];
  providerOf?: (sessionId: string) => string | null;
  events?: Pick<typeof watchEvents, "on">;
}

const HOW: Record<WatchEventKind, string> = {
  done: "finished",
  stopped: "stopped",
  interrupted: "was cut off by a PPM restart",
  expired: "is no longer watched (24 hours passed)",
};

export class AssistantTelegramRelay {
  private offs: Array<() => void> = [];
  private readonly boundChats: (assistantSessionId: string) => string[];
  private readonly connectedChats: () => string[];
  private readonly providerOf: (sessionId: string) => string | null;

  constructor(private readonly deps: RelayDeps) {
    this.boundChats = deps.boundChats ?? telegramChatsBoundTo;
    this.connectedChats = deps.connectedChats ?? (() => reachableChats().map((c) => c.chatId));
    this.providerOf = deps.providerOf ?? getSessionProvider;
  }

  attach(): void {
    if (this.offs.length) return;
    const events = this.deps.events ?? watchEvents;
    this.offs = [
      events.on("watch_decision", (p) => this.onDecision(p)),
      events.on("watch_reported", (p) => this.onReported(p)),
    ];
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Chats that hear about a watch set in this Assistant session (see the header). */
  recipients(assistantSessionId: string): string[] {
    const bound = this.safeBound(assistantSessionId);
    return (bound.length ? bound : this.connectedChats()).filter(canSendTo);
  }

  private onDecision(p: WatchEvents["watch_decision"]): void {
    const card: RelayedCard = {
      targetSessionId: p.targetSessionId, targetProject: p.targetProject, targetProvider: p.targetProvider,
      targetTitle: p.targetTitle, card: p.card,
    };
    for (const chatId of this.recipients(p.assistantSessionId)) this.deps.relayCard(chatId, card);
  }

  private onReported(p: WatchEvents["watch_reported"]): void {
    if (this.safeBound(p.assistantSessionId).length > 0) return;
    const chats = this.connectedChats().filter(canSendTo);
    if (!chats.length) return;
    void this.sendReport(chats, p).catch((e) => log.warn(`watch report for ${p.targetSessionId} not relayed: ${(e as Error).message}`));
  }

  private async sendReport(chats: string[], p: WatchEvents["watch_reported"]): Promise<void> {
    const title = truncateText(redactForTelegram(p.targetTitle.replace(/\s+/g, " ").trim() || "Untitled"), TITLE_MAX);
    const project = redactForTelegram(p.targetProject);
    const report = redactForTelegram(truncateText(p.text.trim(), RELAYED_REPORT_MAX));
    let html = `🔔 <b>${escapeTelegramHtml(title)}</b> in ${escapeTelegramHtml(project)} ${escapeTelegramHtml(HOW[p.kind] ?? p.kind)}.`;
    if (report) html += `\n\n${escapeTelegramHtml(report)}`;
    const url = await this.deps.chatLink(p.targetProject, this.safeProvider(p.targetSessionId), p.targetSessionId).catch(() => null);
    const link = url ? placeLink(url) : {};
    if (link.inline) html += `\n\n${link.inline}`;
    for (const chatId of chats) {
      this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
        html,
        ...(link.button ? {
          markup: { inline_keyboard: [[link.button]] },
          fallbackHtml: `${html}\n\n${escapeTelegramHtml(link.button.text)}: ${escapeTelegramHtml(link.button.url!)}`,
        } : {}),
      }, { label: "watch report" }));
    }
  }

  private safeBound(assistantSessionId: string): string[] {
    try {
      return this.boundChats(assistantSessionId);
    } catch {
      return [];
    }
  }

  private safeProvider(sessionId: string): string | null {
    try {
      return this.providerOf(sessionId);
    } catch {
      return null;
    }
  }
}
