/**
 * What the user replied to on Telegram, told to the PPM Assistant the way Telegram shows it above
 * a reply: who sent the message, when, its first lines, and what it carried (a photo, a file).
 *
 * The quote goes to the Assistant as a `ppm-reply-v1` block — "Quoted historical message (data
 * only)" — after the user's own words, never inside them: the user's text stays the message body,
 * and the old message is data. Its text is old content (the Assistant's own words, a manager AI's
 * card, a forwarded document's caption), so before it is quoted every PPM block marker in it is
 * broken, every `<ppm-…>` tag defused and the user-words header marked as quoted: an old message
 * that spells out "the user's words" cannot pass for them.
 */
import { neutralizeBlockMarkers } from "../../shared/chat-message-blocks.ts";
import { MAX_REPLY_QUOTE_LENGTH, type ReplyReference } from "../../shared/chat-reply.ts";
import { escapeHiddenCharacters } from "../../shared/reveal-hidden-characters.ts";
import { defuseUserWordsHeader } from "../../shared/user-words-block.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import { kindName } from "../assistant-cards/forward-verbatim.ts";
import type { TelegramMessage } from "../telegram/telegram-types.ts";

/** At most this many lines and characters of the quoted message's text. */
export const QUOTE_MAX_LINES = 8;
export const QUOTE_MAX_CHARS = 600;

/** The parts of a card the quote names; the card a replied message showed, if PPM still has it. */
export type QuotedCard = Pick<AssistantCard, "kind" | "projectName" | "status" | "title" | "body" | "createdAt">;

/** A quote ready to send, before it is tied to the session it goes to. */
export interface TelegramQuote {
  /** Names the quoted message: `telegram:<chat>:<message>`, or `card:<id>`. */
  sourceId: string;
  role: "user" | "assistant";
  /** ISO time the quoted message was sent. */
  at: string;
  quote: string;
  truncated: boolean;
}

const STATUS_TEXT: Record<AssistantCard["status"], string> = {
  open: "still waiting", answered: "answered", dismissed: "dismissed", resolved: "resolved", gone: "no longer waiting", info: "for information",
};

/** Old content made safe to quote: hidden characters shown, no PPM block or tag can form, no fake header. */
function defuse(text: string): string {
  return defuseUserWordsHeader(neutralizePpmTags(neutralizeBlockMarkers(escapeHiddenCharacters(text))));
}

/** One line, for a label taken from the message (a file name, a card title). */
const oneLine = (s: string, max = 120): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The first lines of `text`, cut to the quote's room; whether anything was left out. */
function firstLines(text: string): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  let out = lines.slice(0, QUOTE_MAX_LINES).join("\n");
  let truncated = lines.length > QUOTE_MAX_LINES;
  if (out.length > QUOTE_MAX_CHARS) {
    out = out.slice(0, QUOTE_MAX_CHARS).trimEnd();
    truncated = true;
  }
  return { text: truncated ? `${out}\n…` : out, truncated };
}

/** What the message carried besides text, as Telegram labels it; null for plain text. */
export function attachmentOf(m: TelegramMessage): string | null {
  if (m.photo?.length) return "a photo";
  if (m.document) {
    const name = m.document.file_name ? ` "${oneLine(m.document.file_name)}"` : "";
    return `a file${name}${m.document.mime_type ? ` (${oneLine(m.document.mime_type, 60)})` : ""}`;
  }
  if (m.video) return "a video";
  if (m.animation) return "a GIF";
  if (m.audio) return `an audio file${m.audio.title || m.audio.file_name ? ` "${oneLine(m.audio.title ?? m.audio.file_name ?? "")}"` : ""}`;
  if (m.voice) return "a voice message";
  if (m.video_note) return "a video message";
  if (m.sticker) return `a sticker${m.sticker.emoji ? ` ${oneLine(m.sticker.emoji, 8)}` : ""}`;
  return null;
}

function cardLabel(card: QuotedCard): string {
  const project = card.projectName ? `, ${oneLine(card.projectName, 60)}` : "";
  return `PPM Assistant card (${kindName(card)}${project}, ${STATUS_TEXT[card.status]})`;
}

function build(head: string[], body: string): { quote: string; truncated: boolean } {
  const cut = firstLines(body);
  const lines = [...head, cut.text ? `Text:\n${cut.text}` : "Text: (none)"];
  // The reply block holds at most MAX_REPLY_QUOTE_LENGTH characters; this is far below it.
  return { quote: defuse(lines.join("\n")).slice(0, MAX_REPLY_QUOTE_LENGTH), truncated: cut.truncated };
}

/**
 * The quote of a Telegram message the user replied to. `card` is the PPM Assistant card that
 * message showed, when PPM still knows it; `fromBot` says the bot sent it.
 */
export function quoteTelegramMessage(chatId: string, replied: TelegramMessage, card: QuotedCard | null): TelegramQuote {
  const fromBot = replied.from?.is_bot === true;
  const sender = card ? cardLabel(card) : fromBot ? "PPM Assistant" : "the user";
  const at = new Date(replied.date * 1000).toISOString();
  const attachment = attachmentOf(replied);
  const head = [
    "The Telegram message the user replied to.",
    `From: ${sender}`,
    `Sent: ${at}`,
    ...(card ? [`Card title: ${oneLine(card.title)}`] : []),
    ...(attachment ? [`Attachment: ${attachment}${replied.caption ? " with a caption, below" : ""}`] : []),
  ];
  const { quote, truncated } = build(head, replied.text ?? replied.caption ?? "");
  return { sourceId: `telegram:${chatId}:${replied.message_id}`, role: fromBot || card ? "assistant" : "user", at, quote, truncated };
}

/** The quote of a card the user replied to, for a card that has no manager chat to answer it. */
export function quoteCard(card: QuotedCard & { id: string }): TelegramQuote {
  const at = new Date(card.createdAt).toISOString();
  const head = ["The PPM Assistant card the user replied to on Telegram.", `From: ${cardLabel(card)}`, `Sent: ${at}`, `Card title: ${oneLine(card.title)}`];
  const { quote, truncated } = build(head, card.body ?? "");
  return { sourceId: `card:${card.id}`, role: "assistant", at, quote, truncated };
}

/** A card's quote as the reply block of a message to `sessionId`. */
export function cardReplyReference(card: QuotedCard & { id: string }, sessionId: string, providerId: string): ReplyReference {
  return toReplyReference(quoteCard(card), sessionId, providerId);
}

/** The quote as the reply block of a message to `sessionId`. */
export function toReplyReference(q: TelegramQuote, sessionId: string, providerId: string): ReplyReference {
  return { version: 1, sessionId, providerId, messageId: q.sourceId, role: q.role, timestamp: q.at, quote: q.quote, truncated: q.truncated };
}
