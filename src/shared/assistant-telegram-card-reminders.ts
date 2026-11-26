/**
 * Card reminders on Telegram (`clawbot.card_reminders`, `clawbot.card_reminder_minutes`): the
 * names and limits the server, Settings and the Assistant's `settings_*` tools share. The rule
 * itself lives in `src/services/assistant-telegram/assistant-telegram-card-reminders.ts`.
 */

/** Minutes a card sent without a sound waits before its one reminder. */
export const CARD_REMINDER_MINUTES = { min: 1, max: 240, default: 5 } as const;

export const CARD_REMINDERS_LABEL = "Remind me about unanswered cards";

export const CARD_REMINDERS_NOTE =
  "A card sent without a sound while you were at PPM gets one reminder, with a sound, if nobody answers it in time. "
  + "Cards due together come as one message. Never sent in quiet hours: what is still waiting comes once they end.";

/** A whole number of minutes within {@link CARD_REMINDER_MINUTES}, or null. */
export function validReminderMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    && value >= CARD_REMINDER_MINUTES.min && value <= CARD_REMINDER_MINUTES.max ? value : null;
}
