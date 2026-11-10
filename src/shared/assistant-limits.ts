/**
 * Budgets and caps for PPM Assistant and the manager chats it works through, in one place so the
 * server, the tests and the docs quote the same numbers.
 */

/** A project's `.ppm/manager.md` larger than this is held whole for the user, never truncated. */
export const RULES_FILE_MAX_BYTES = 16 * 1024;

/** How long the one-shot check of a manager's added rule lines may take; past it the change is held. */
export const RULES_CHECK_TIMEOUT_MS = 15_000;
