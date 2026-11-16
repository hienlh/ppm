/**
 * What every PPM Tasks surface on Telegram shares: how the user's own writes are signed, how a
 * button's text is made safe, and how a task card is edited in place.
 */
import type { WriteContext } from "../../shared/ppm-tasks.ts";
import { truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import { outcomeOf, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";

/** Said when a press names a deck or card PPM no longer holds (a restart, or evicted). */
export const GONE_TOAST = "This list is no longer open — send /tasks again.";

/** The user's own writes from Telegram: the user acts, never the Assistant. */
export const telegramUserCtx = (reason?: string): WriteContext => ({ actor: { kind: "user", label: "You" }, via: "telegram", ...(reason ? { reason } : {}) });

/** Plain button text (Telegram shows it as typed, no HTML): redacted and cut short. */
export const buttonText = (text: string, max = 40): string => truncateText(redactForTelegram(text.replace(/\s+/g, " ").trim()), max);

/** Edits a card in place; a newer edit of the same message replaces one still waiting. */
export function editCard(queue: AssistantTelegramSendQueue, chatId: string, messageId: number, html: string, rows: InlineKeyboardButton[][]): void {
  let attempts = 0;
  queue.enqueue(chatId, {
    key: `task-card:${chatId}:${messageId}`, final: true, label: "task card",
    run: async (client) => outcomeOf(await client.editMessageText(chatId, messageId, html, {
      final: true, replyMarkup: { inline_keyboard: rows },
    }), ++attempts),
  });
}
