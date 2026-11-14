/**
 * "Quiet while I'm at PPM" (`clawbot.quiet_while_in_ppm`): the names the server and the browser
 * share. The rule itself lives in `src/services/assistant-telegram/assistant-telegram-silence.ts`.
 */

/** Sent on `/ws/global` (and re-dispatched as a window event) whenever the switch changes: `{ on }`. */
export const QUIET_CHANGED_EVENT = "assistant:telegram_quiet_changed";

export const QUIET_SWITCH_LABEL = "Quiet while I'm at PPM";

export const QUIET_SWITCH_NOTE =
  "While you use PPM (or typed there in the last 5 minutes), messages on Telegram arrive without a sound. "
  + "A card left unanswered for 5 minutes is sent once more with a sound. Quiet hours still apply.";
