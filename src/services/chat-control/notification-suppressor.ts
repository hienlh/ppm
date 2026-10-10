import { createLogger } from "../logger.ts";

/**
 * Lets parts of the server hold back a chat's push notifications ("Chat completed",
 * "Waiting for approval") when the user is already being told another way — a turn answered on
 * Telegram is on the user's phone already, and an alert for it would say the same thing twice.
 *
 * Several may be registered (a Telegram bridge, a watch); the notification is held back when any
 * of them claims it. Only the notification is held back: the chat is still marked unread, because
 * an unread mark is what tells every PPM screen where to look.
 */

export type SuppressibleNotification = "done" | "approval";
export type NotificationSuppressor = (sessionId: string, kind: SuppressibleNotification) => boolean;

const log = createLogger("chat-notifications");
const suppressors = new Set<NotificationSuppressor>();

/** Registers a suppressor; the returned function removes it. */
export function addNotificationSuppressor(fn: NotificationSuppressor): () => void {
  suppressors.add(fn);
  return () => { suppressors.delete(fn); };
}

/**
 * Whether the notification should be held back. A suppressor that throws claims nothing — a
 * broken bridge must not silence alerts — and the others are still asked.
 */
export function isNotificationSuppressed(sessionId: string, kind: SuppressibleNotification): boolean {
  for (const fn of [...suppressors]) {
    try {
      if (fn(sessionId, kind) === true) return true;
    } catch (e) {
      log.warn(`session=${sessionId} a notification suppressor failed for ${kind}, ignoring it: ${(e as Error)?.message ?? e}`);
    }
  }
  return false;
}
