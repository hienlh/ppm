/**
 * What the manager's answer to a card reply says on Telegram. It is manager-written text going to
 * a phone, so it gets everything a card's own text gets: hidden characters shown, secrets redacted
 * (and counted), the project's detail level obeyed, escaped for Telegram's HTML — through the same
 * Markdown formatter the Assistant's answers use, which escapes before it formats. Redaction runs
 * before the cut, so a secret straddling the cut cannot leave half of itself behind.
 *
 * - `full`: the answer, cut to {@link CARD_FOLLOWUP_MAX_CHARS} with "see the chat" and a link.
 * - `title`: no answer text at all — only that the manager answered, and the link.
 * - a stopped or failed turn: only that it stopped before answering, and the link.
 *
 * A card the manager opened in the same turn (asking again) goes out on its own, at once, as every
 * card does; the follow-up names it so the two read together.
 */
import { CARD_FOLLOWUP_MAX_CHARS } from "../../shared/assistant-limits.ts";
import { escapeHiddenCharacters } from "../../shared/reveal-hidden-characters.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { markdownToTelegramHtml, redactSecretsForTelegram } from "../telegram/telegram-html-format.ts";
import type { InlineKeyboardMarkup } from "../telegram/telegram-types.ts";
import { cutFollowupText } from "../assistant-cards/card-reply-followup-tracker.ts";
import { cleanTelegramText, type CardDetail } from "./assistant-telegram-card-kinds.ts";
import { placeLink } from "./assistant-telegram-links.ts";

export interface FollowupFormatInput {
  text: string;
  /** The turn said more than was kept. */
  overflow: boolean;
  detail: CardDetail;
  projectName: string | null;
  newCards: Array<{ title: string }>;
  /** Opens the manager chat in PPM; null when no link could be made. */
  url: string | null;
  /** The manager's turn was stopped or failed before it answered: only that is said. */
  stopped?: boolean;
}

export interface FormattedFollowup {
  html: string;
  markup?: InlineKeyboardMarkup;
  /** The text with the link in it, for when Telegram refuses the link as a button. */
  fallbackHtml?: string;
}

export const FOLLOWUP_LABEL = "💬 <b>The manager's answer to your reply</b>";
export const FOLLOWUP_CUT_NOTE = "… see the chat for the rest.";
export const FOLLOWUP_TITLE_ONLY_NOTE = "The manager answered your reply; the details stay in PPM for this project.";
export const FOLLOWUP_STOPPED_NOTE = "The manager's turn was stopped before it answered; see the chat.";

export function formatCardFollowup(input: FollowupFormatInput): FormattedFollowup {
  const counter = { hidden: 0 };
  const project = input.projectName ? ` · ${cleanTelegramText(input.projectName.replace(/\s+/g, " ").trim(), counter)}` : "";
  // A stopped turn's partial text is never shown: one line, whatever the project's detail level.
  if (input.stopped) return withLink(`⏹ <i>${escapeTelegramHtml(FOLLOWUP_STOPPED_NOTE)}</i>${project}`, input.url);
  const lines = [`${FOLLOWUP_LABEL}${project}`];
  if (input.detail === "full") {
    const redacted = redactSecretsForTelegram(escapeHiddenCharacters(input.text));
    counter.hidden += redacted.hidden;
    const cut = cutFollowupText(redacted.text, CARD_FOLLOWUP_MAX_CHARS, input.overflow);
    lines.push(markdownToTelegramHtml(cut.text));
    if (cut.truncated) lines.push(`<i>${escapeTelegramHtml(FOLLOWUP_CUT_NOTE)}</i>`);
  } else {
    lines.push(`<i>${escapeTelegramHtml(FOLLOWUP_TITLE_ONLY_NOTE)}</i>`);
  }
  for (const card of input.newCards.slice(0, 3)) {
    lines.push(`<i>It also opened a new card: </i><b>${cleanTelegramText(card.title.replace(/\s+/g, " ").trim(), counter)}</b>`);
  }
  if (counter.hidden > 0) lines.push(`<i>🔒 ${counter.hidden} secret-looking value${counter.hidden === 1 ? "" : "s"} hidden.</i>`);
  return withLink(lines.join("\n"), input.url);
}

/** The Open in PPM link: a button where Telegram takes one, else written into the text. */
function withLink(html: string, url: string | null): FormattedFollowup {
  if (!url) return { html };
  const link = placeLink(url);
  if (link.inline) return { html: `${html}\n\n${link.inline}` };
  return {
    html,
    markup: { inline_keyboard: [[link.button!]] },
    fallbackHtml: `${html}\n\n${escapeTelegramHtml(link.button!.text)}: ${escapeTelegramHtml(link.button!.url!)}`,
  };
}
