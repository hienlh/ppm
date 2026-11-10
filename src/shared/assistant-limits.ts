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

/** Reports one manager chat may file per rolling hour. */
export const REPORTS_PER_MANAGER_PER_HOUR = 20;

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
