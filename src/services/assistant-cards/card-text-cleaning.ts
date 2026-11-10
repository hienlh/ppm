import { neutralizeBlockMarkers } from "../../shared/chat-message-blocks.ts";
import { escapeHiddenCharacters } from "../../shared/reveal-hidden-characters.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";

/**
 * Text a manager chat's AI wrote, made fit for a card the user reads as PPM's. A card is shown as
 * plain text, never as Markdown or HTML, so escaping for markup is the renderer's job; this makes
 * sure the words cannot pass for PPM's own:
 *
 * - every server-only block marker and loose `<ppm-…>` tag is broken, so the text cannot forge the
 *   user's words or a provenance block anywhere it is later quoted;
 * - characters that draw nothing or reorder text are shown as `⟨U+XXXX⟩`;
 * - a title loses leading emoji and symbols and openers that imitate PPM's own cards ("PPM",
 *   "Allow", "Approval"), so a report cannot pose as an approval prompt.
 */

/** Longest card title. */
export const MAX_CARD_TITLE = 120;
/** Longest report body. */
export const MAX_CARD_BODY = 2000;

const NEUTRAL = (text: string): string => neutralizePpmTags(neutralizeBlockMarkers(text));

// Leading pictographs, symbols, punctuation and spaces (an emoji, "⚠️", "✅ ", "🔔:", "[" …). Digits
// stay: "2 tests failed" keeps its 2.
const LEADING_SYMBOLS = /^[\s\p{Extended_Pictographic}\p{So}\p{Sk}\p{P}‍️⃣\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]+/u;
// An opener that imitates PPM's own wording, with what usually follows it.
const IMITATING_OPENER = /^(?:ppm|allow|approval|approve)\b[\s:;,.\-–—·|>]*/iu;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** A report's title: one line, revealed, neutralized, stripped of imitating openers, capped. */
export function cleanCardTitle(raw: unknown, fallback = "Report"): string {
  if (typeof raw !== "string") return fallback;
  let text = NEUTRAL(raw).replace(/\s+/g, " ").trim();
  // Stripped until nothing changes: "✅ PPM: Allow — x" loses all three.
  for (let i = 0; i < 6; i++) {
    const next = text.replace(LEADING_SYMBOLS, "").replace(IMITATING_OPENER, "").trim();
    if (next === text) break;
    text = next;
  }
  text = escapeHiddenCharacters(text);
  return cap(text, MAX_CARD_TITLE) || fallback;
}

/** A report's body or a draft: line breaks kept, revealed, neutralized, capped. */
export function cleanCardBody(raw: unknown, max = MAX_CARD_BODY): string {
  if (typeof raw !== "string") return "";
  return cap(escapeHiddenCharacters(NEUTRAL(raw.replace(/\r\n?/g, "\n"))).trim(), max);
}
