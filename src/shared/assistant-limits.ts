/**
 * Budgets and caps for PPM Assistant and the manager chats it works through, in one place so the
 * server, the tests and the docs quote the same numbers.
 */

/** A project's `.ppm/manager.md` larger than this is held whole for the user, never truncated. */
export const RULES_FILE_MAX_BYTES = 16 * 1024;

/** How long the one-shot check of a manager's added rule lines may take; past it the change is held. */
export const RULES_CHECK_TIMEOUT_MS = 15_000;

/**
 * Messages one Assistant session may send to manager chats in turns nobody started, per rolling
 * hour and per rolling day. Never refilled by a message from the user: only time frees them.
 */
export const UNATTENDED_SENDS_PER_HOUR = 6;
export const UNATTENDED_SENDS_PER_DAY = 20;

/** The same text to the same manager chat within this window is dropped as already sent. */
export const DUPLICATE_SEND_WINDOW_MS = 60 * 60_000;

/** The user's opening words a provenance block quotes, at most. */
export const PROVENANCE_OPENING_MAX_CHARS = 200;

/**
 * Turns PPM starts on its own in one Assistant session per rolling hour: watch reports, manager
 * reports, the digest and late replies alike. News over the cap waits and goes into the next turn.
 */
export const WAKE_TURNS_PER_HOUR = 6;

/**
 * When restart news counts as urgent — starts its turn during quiet hours, and lets that turn
 * message manager chats despite them: `cut_off_chats` only when a restart cut a chat off mid-turn
 * (work is stalled until someone resumes it); `always`; or `never` (held like any other news).
 */
export const RESTART_NEWS_URGENT_WHEN: "cut_off_chats" | "always" | "never" = "cut_off_chats";

/** Restarts one pending restart news item lists at most; older ones are dropped as they merge in. */
export const RESTART_NEWS_MAX_RESTARTS = 10;

/** Urgent reports one manager chat may file per quiet window; past it, urgent becomes a decision. */
export const URGENT_PER_MANAGER_PER_QUIET_WINDOW = 2;

/** Longest quote of one report field in the news the Assistant reads; the card keeps all of it. */
export const NEWS_QUOTE_MAX = 500;

/** A failure PPM saw in a manager chat becomes a card only if the manager has not reported by then. */
export const FAILED_CARD_GRACE_MS = 10 * 60_000;

/** A reply to a card older than this (or no longer open) is sent only after the user confirms. */
export const STALE_REPLY_MS = 24 * 60 * 60_000;

/** The longest reply to a card PPM forwards word for word. */
export const CARD_REPLY_MAX_CHARS = 8000;

/**
 * Most of the manager's answer to a card reply that goes back to the user (Telegram and the card in
 * PPM); the rest is in the manager chat, which the follow-up links to.
 */
export const CARD_FOLLOWUP_MAX_CHARS = 1500;

/**
 * How long after a reply typed on Telegram its answer still rings whatever "quiet while I'm at PPM"
 * and quiet hours say: the user is holding the phone for minutes, not hours. A later answer (the
 * reply started a long task) follows the quiet rules: silent while at PPM or in quiet hours.
 */
export const CARD_FOLLOWUP_LOUD_MS = 30 * 60_000;

/** The whole notebook, every line's text together, whoever wrote it. */
export const NOTEBOOK_CAP_CHARS = 4000;
/** One notebook line. */
export const NOTE_MAX_CHARS = 300;
/** Room in the notebook only the user may fill: the Assistant's writes stop this far short of the cap. */
export const NOTEBOOK_USER_RESERVE_CHARS = 1000;

/**
 * How long a card may stand unanswered on a chat's screen before the chat counts as stopped on it:
 * its Assistant card then says since when, and Telegram is told once more, with a sound, whether or
 * not the user is at PPM. A chat waiting on a card does nothing else until it is answered.
 */
export const APPROVAL_OVERDUE_MS = 3 * 60_000;

/**
 * Cards one chat (a manager, or the PPM Assistant) may withdraw or replace in one turn. Past it the
 * call is refused, and the chat asks the user on a card: the user's OK opens a new turn.
 */
export const WITHDRAW_PER_TURN = 5;
/** When PPM cannot tell which turn a withdrawal ran in, the limit counts this long back instead. */
export const WITHDRAW_FALLBACK_WINDOW_MS = 10 * 60_000;
/** The longest reason a withdrawal takes. */
export const WITHDRAW_REASON_MAX = 200;
