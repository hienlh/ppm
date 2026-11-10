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
