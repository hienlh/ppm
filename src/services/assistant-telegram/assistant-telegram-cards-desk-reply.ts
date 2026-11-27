/**
 * Which card a reply to the pinned card desk answers — or that it answers none for certain.
 *
 * The desk shows one card at a time and moves on by itself (a card answered in PPM, a new urgent
 * one), so "the card the desk shows now" is not always the card the user was reading when they
 * wrote. Words are a free-text answer that reaches a manager or answers a question, so a guess is
 * worse than asking again: the reply goes to the card only when it is certain, and otherwise the
 * user is told to reply to the card's own message.
 */

/** The card the phone shows, as Telegram confirmed it (set only once an edit or a send went through). */
export interface ShownCard {
  key: string;
  /** When the desk started showing it (ms). */
  from: number;
  /** The user moved the desk there by pressing on it, so they saw it come up. */
  byPress: boolean;
  /** Shown whole, with its buttons (not too long for the desk). */
  full: boolean;
}

/**
 * After the desk moved to another card by itself, a reply written this soon may have been meant
 * for the card shown before: it is refused, not routed.
 */
export const DESK_REPLY_SETTLE_MS = 60_000;

/** Said when a reply to the desk cannot be matched for certain to the card the user was reading. */
export const DESK_REPLY_UNSURE = "Not sent: the pinned list changed while you were writing, so it is not clear which card this answers. "
  + "Reply to the card's own message (↩ Go to the card's message), or reply to the list again.";
export const DESK_REPLY_MOVED = "Not sent: that list moved down. Reply to the pinned list at the bottom, or to the card's own message.";

/** Where a reply to a desk goes: the card's own message, or nowhere with the line to say why. */
export type DeskReply = { to: number } | { refuse: string };

/**
 * `target` is the shown card's own message (null when it has none); `sentAt` is the reply's date in
 * ms, which Telegram gives to the second — a reply written in the second the card came up counts.
 */
export function deskReplyFor(shown: ShownCard | null, target: number | null, sentAt: number): DeskReply {
  if (!shown || target === null || !shown.full) return { refuse: DESK_REPLY_UNSURE };
  if (sentAt < Math.floor(shown.from / 1000) * 1000) return { refuse: DESK_REPLY_UNSURE };
  if (!shown.byPress && sentAt < shown.from + DESK_REPLY_SETTLE_MS) return { refuse: DESK_REPLY_UNSURE };
  return { to: target };
}
