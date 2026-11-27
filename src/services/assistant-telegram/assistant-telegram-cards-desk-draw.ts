/**
 * What the pinned card desk says and which buttons it carries (`assistant-telegram-cards-desk.ts`
 * keeps it up to date). One message per Telegram chat:
 *
 *   🔔 Waiting for you (3)
 *   ▸ 1. 🔐 nxsys · Allow a command   40m
 *     2. 🔔 ppm · Telegram list style  1h
 *     3. ❓ vn-legal-rag · Re-index?    3h
 *   ───
 *   <the current card, whole, exactly as its own message shows it>
 *   [the card's own answer buttons]
 *   [1] [• 2 •] [3]           (or ‹ 2 / 12 › past eight cards)
 *   [↩ Go to the card's message]
 *
 * The card part is the card's own view, its HTML and its buttons untouched: the buttons are the
 * card's own codes, so pressing one here is pressing it on the card, and Allow is on the desk only
 * when the card offered it — which it does only when the whole deciding part is in its text. When
 * the list and the card together would not fit in one message, the list shrinks to its count; if
 * the card alone still does not fit, the desk says to answer it on its own message and shows none
 * of its buttons, rather than buttons standing for text the phone did not show.
 */
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram, stripTelegramHtml } from "../telegram/telegram-html-format.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import type { DeskPress } from "./assistant-telegram-actions.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";

/** One card waiting on the user, as the desk lists it. */
export interface DeskEntry {
  /** Unique within a chat: `card:<requestId>`, `mcard:<cardId>`, `db:<requestId>`. */
  key: string;
  icon: string;
  /** Plain text; redacted, cut and escaped here. */
  project: string | null;
  /** Plain text; redacted, cut and escaped here. */
  title: string;
  /** When the card was made or sent, for its age and its place in the list. */
  since: number;
  /** An urgent card goes to the top of the list. */
  urgent?: boolean;
  /** The card's own message in this chat, which "Go to the card" replies to; null when unknown. */
  messageId: number | null;
  /** Read at every draw: a card that stopped waiting leaves the desk even if nobody said so. */
  stillWaiting(): boolean;
  /** The card as its own message shows it now: its HTML and its buttons (its own codes). */
  view(): { html: string; rows: InlineKeyboardButton[][] };
  /** The code groups behind `view().rows`, kept alive while the desk shows them. */
  groups: string[];
}

export type DeskKeyMaker = (text: string, press: Omit<DeskPress, "kind">) => InlineKeyboardButton;

/** Lines the list shows; the rest are counted. */
export const DESK_LIST_MAX = 10;
/** Up to this many cards, each gets a numbered button; past it, ‹ n / N ›. */
export const DESK_TABS_MAX = 8;
/** Telegram's limit on a message's visible text. */
export const DESK_VISIBLE_MAX = 4096;
const TITLE_MAX = 60;
const PROJECT_MAX = 24;

export const EMPTY_DESK_HTML = "✅ <b>Nothing is waiting for you.</b>\n<i>Cards that need you are listed here as they come.</i>";
export const MOVED_DESK_HTML = "🔔 <i>This list moved down ↓</i>";
export const OFF_DESK_HTML = "🔔 <i>The pinned card list is off. Turn it on in PPM: Settings → PPM Assistant → Telegram.</i>";
export const TOO_LONG_ON_DESK = "This card is too long to show here — answer it on its own message.";
export const UNSHOWABLE_ON_DESK = "This card cannot be shown here — answer it on its own message.";

/** Urgent first, then the oldest: the card that has waited longest is answered first. */
export function sortEntries(entries: DeskEntry[]): DeskEntry[] {
  return [...entries].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.since - b.since || a.key.localeCompare(b.key));
}

/** "now", "12m", "3h", "2d". */
export function ageText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * Vault values and secrets are taken out of the whole text before it is cut: a value cut in half is
 * no longer recognised, and its first half would reach the phone.
 */
const clean = (s: string, max: number): string =>
  escapeTelegramHtml(truncateText(redactForTelegram(turnSecretScrubber.scrub(s.replace(/\s+/g, " ").trim())), max));

/** One line of the list, the current card marked. */
export function entryLine(e: DeskEntry, n: number, current: boolean, now: number): string {
  const project = e.project?.trim() ? `<b>${clean(e.project, PROJECT_MAX)}</b> · ` : "";
  const title = clean(e.title, TITLE_MAX) || "A card";
  const num = current ? `▸ <b>${n}.</b>` : `${n}.`;
  return `${num} ${e.icon} ${project}${title} <i>${ageText(now - e.since)}</i>`;
}

const visible = (html: string): number => stripTelegramHtml(html).length;

export interface DrawnDesk {
  html: string;
  rows: InlineKeyboardButton[][];
  /** The card shown, null when nothing waits. */
  current: DeskEntry | null;
  /** The current card is on the desk whole, with its buttons (not too long, and its view could be read). */
  full: boolean;
}

/**
 * The desk for these cards (already sorted, all still waiting), showing `current` (or, when it
 * is gone, the card at `fallbackIndex`).
 */
export function drawDesk(entries: DeskEntry[], currentKey: string | null, fallbackIndex: number, now: number, key: DeskKeyMaker): DrawnDesk {
  if (!entries.length) return { html: EMPTY_DESK_HTML, rows: [], current: null, full: false };
  let index = entries.findIndex((e) => e.key === currentKey);
  if (index < 0) index = Math.min(Math.max(fallbackIndex, 0), entries.length - 1);
  const current = entries[index]!;
  // A card whose view cannot be read must not keep every later draw of the desk from happening.
  let card: { html: string; rows: InlineKeyboardButton[][] } | null;
  try { card = current.view(); } catch { card = null; }
  const total = entries.length;

  const lines = entries.slice(0, DESK_LIST_MAX).map((e, i) => entryLine(e, i + 1, i === index, now));
  if (total > DESK_LIST_MAX) lines.push(`<i>…and ${total - DESK_LIST_MAX} more</i>`);
  // The current card past the visible list still gets its line, so the list says which it is.
  if (index >= DESK_LIST_MAX) lines.push(entryLine(current, index + 1, true, now));
  const full = [`🔔 <b>Waiting for you (${total})</b>`, ...lines].join("\n");
  const compact = `🔔 <b>Waiting for you · ${index + 1} of ${total}</b>`;
  const rule = "\n───\n";

  if (!card) {
    const html = `${visible(full) + 80 > DESK_VISIBLE_MAX ? compact : full}${rule}${escapeTelegramHtml(UNSHOWABLE_ON_DESK)}`;
    return { html, rows: [...navRows(entries, index, key), ...jumpRow(current, key)], current, full: false };
  }
  let html = `${full}${rule}${card.html}`;
  let answerRows = card.rows;
  let whole = true;
  if (visible(html) > DESK_VISIBLE_MAX) html = `${compact}${rule}${card.html}`;
  if (visible(html) > DESK_VISIBLE_MAX) {
    html = `${compact}${rule}${escapeTelegramHtml(TOO_LONG_ON_DESK)}`;
    answerRows = [];
    whole = false;
  }
  return { html, rows: [...answerRows, ...navRows(entries, index, key), ...jumpRow(current, key)], current, full: whole };
}

function navRows(entries: DeskEntry[], index: number, key: DeskKeyMaker): InlineKeyboardButton[][] {
  const total = entries.length;
  if (total < 2) return [];
  if (total <= DESK_TABS_MAX) {
    const tabs = entries.map((e, i) => key(i === index ? `• ${i + 1} •` : `${i + 1}`, { op: "show", key: e.key }));
    return total <= 4 ? [tabs] : [tabs.slice(0, Math.ceil(total / 2)), tabs.slice(Math.ceil(total / 2))];
  }
  return [[key("‹", { op: "prev" }), key(`${index + 1} / ${total}`, { op: "show", key: entries[index]!.key }), key("›", { op: "next" })]];
}

function jumpRow(current: DeskEntry, key: DeskKeyMaker): InlineKeyboardButton[][] {
  return current.messageId !== null ? [[key("↩ Go to the card's message", { op: "jump", key: current.key })]] : [];
}

/** The short line sent under a card's own message, so a tap on its quote scrolls there. */
export function jumpHtml(e: DeskEntry): string {
  return `↑ ${e.icon} ${clean(e.title, TITLE_MAX) || "This card"}`;
}
