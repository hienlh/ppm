/**
 * Which card a reply to the pinned card desk answers.
 *
 * The desk moves by itself (a card answered in PPM, a new one, a restart), so "the card the desk
 * shows now" is not always the card the user was reading when they wrote. Every version Telegram
 * confirmed is kept as a snapshot (`DeskSnapshot`: which card was shown whole, which lines were
 * listed, from when), and a reply is matched against the versions the user could have seen while
 * writing it, never against the desk as it is now.
 *
 * The words are never dropped. A reply goes straight to a card when the evidence names one card the
 * user saw; otherwise PPM keeps the words and asks which card they answer (`ask`), with a button per
 * card, so a card the user never saw is only ever reached by their own press.
 *
 * Evidence, in order:
 * 1. A quote the user picked from the desk names a card (its line, or the shown card's text).
 * 2. One card was shown whole the whole time the user may have been writing.
 * 3. The desk lists one card, the user saw it, and no card they saw shown was answered meanwhile
 *    (their words may have been meant for that one).
 * 4. The words are one of the choices of exactly one card the user saw.
 */

/** One version of the desk, as Telegram confirmed it. */
export interface DeskSnapshot {
  /** The desk's message. */
  messageId: number;
  /** When the version went up (ms). */
  from: number;
  /** The card shown whole, null when none was. */
  shown: string | null;
  /** The user put the desk on that card by pressing on it: from here they were reading it. */
  byPress: boolean;
  /** Each listed card's line, as the phone shows it (plain text). */
  lines: Array<{ key: string; text: string }>;
  /** The shown card's part, as the phone shows it (plain text). */
  shownText: string;
}

/** A card waiting on the desk now, and the choices it offers (a question's options). */
export interface DeskWaitingCard {
  key: string;
  answers?: readonly string[];
}

export interface DeskReplyInput {
  /** When the reply was sent (ms; Telegram dates to the second). */
  sentAt: number;
  /** The words the user wrote. */
  text: string;
  /** The part of the desk the user quoted, when they picked one. */
  quote?: string | null;
}

/**
 * How long a reply may have taken to write. A desk version that was up anywhere in this window
 * before the reply was sent may be the one the user was reading.
 */
export const DESK_REPLY_LOOKBACK_MS = 3 * 60_000;

export type DeskReplyDecision =
  /** The card to answer, and why (for the log). */
  | { to: string; why: string }
  /**
   * Not certain: ask, listing the waiting cards the user saw first; `ended` names cards the user saw
   * that stopped waiting meanwhile (answered elsewhere), so the question can say so.
   */
  | { ask: string[]; ended: string[] };

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The versions that were up at some moment while the reply may have been written, oldest first. */
export function seenVersions(history: readonly DeskSnapshot[], sentAt: number): DeskSnapshot[] {
  // Telegram dates a message to the second: a version that went up in that second may have been seen.
  const until = Math.floor(sentAt / 1000) * 1000 + 999;
  const upto = history.filter((s) => s.from <= until).sort((a, b) => a.from - b.from);
  const start = sentAt - DESK_REPLY_LOOKBACK_MS;
  let seen = upto.filter((s, i) => (upto[i + 1]?.from ?? Infinity) > start);
  // The user moved the desk themselves: from that version on, they were reading what they chose.
  const pressed = seen.map((s) => s.byPress).lastIndexOf(true);
  if (pressed > 0) seen = seen.slice(pressed);
  return seen;
}

export function resolveDeskReply(history: readonly DeskSnapshot[], waiting: readonly DeskWaitingCard[], input: DeskReplyInput): DeskReplyDecision {
  const seen = seenVersions(history, input.sentAt);
  const waitingKeys = new Set(waiting.map((w) => w.key));
  const shownKeys = unique(seen.map((s) => s.shown).filter((k): k is string => k !== null));
  const listedKeys = unique(seen.flatMap((s) => s.lines.map((l) => l.key)));
  const seenKeys = unique([...shownKeys, ...listedKeys]);

  // 1. A quote taken from the desk names the card it was taken from.
  const quote = input.quote ? norm(input.quote) : "";
  if (quote) {
    const quoted = unique(seen.flatMap((s) => {
      const fromLines = s.lines.filter((l) => norm(l.text).includes(quote)).map((l) => l.key);
      if (fromLines.length) return fromLines;
      return s.shown && norm(s.shownText).includes(quote) ? [s.shown] : [];
    }));
    if (quoted.length === 1 && waitingKeys.has(quoted[0]!)) return { to: quoted[0]!, why: "quote" };
  }
  // 2. The same card was on the desk the whole time (and still waits: an answered one is asked about).
  if (shownKeys.length === 1 && seen.every((s) => s.shown === shownKeys[0]) && waitingKeys.has(shownKeys[0]!)) {
    return { to: shownKeys[0]!, why: "one card shown" };
  }
  // 3. One card left, the user saw it, and no card they were shown went away meanwhile.
  if (waitingKeys.size === 1 && shownKeys.every((k) => waitingKeys.has(k))) {
    const only = [...waitingKeys][0]!;
    if (seenKeys.includes(only)) return { to: only, why: "one card left" };
  }
  // 4. The words are a choice of exactly one card the user saw.
  const words = norm(input.text);
  if (words) {
    const matching = waiting.filter((w) => seenKeys.includes(w.key) && (w.answers ?? []).some((a) => norm(a) === words));
    if (matching.length === 1) return { to: matching[0]!.key, why: "one card's choice" };
  }
  // Ask: the cards the user saw first (the shown ones, then the listed ones), then the rest.
  const order = unique([...shownKeys, ...listedKeys, ...waiting.map((w) => w.key)]).filter((k) => waitingKeys.has(k));
  return { ask: order, ended: shownKeys.filter((k) => !waitingKeys.has(k)) };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
