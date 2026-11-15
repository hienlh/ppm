import { USER_WORDS_BLOCK_END, USER_WORDS_BLOCK_START } from "./assistant-provenance";
import { CARD_OPTION_ID_RE, CARD_OPTION_LABEL_MAX } from "./assistant-cards";

/**
 * The user's own words, forwarded word for word by PPM to a manager chat: the text the user typed
 * in reply to one of the PPM Assistant's cards (in PPM or on Telegram), their OK on a card's
 * draft, or the choice they pressed on a card that offered several. The text is the message body; this block follows it and says who wrote it.
 *
 * Only `forward-verbatim.ts` encodes one. Every other door breaks the block's markers in the text
 * it is handed (`neutralizeBlockMarkers`), the forwarded text included, so neither a model nor a
 * card title nor the user's own pasted text can produce a block that decodes. The decoder rebuilds
 * the header line from the block's JSON and keeps the block as plain text unless the two match.
 * The card is named by id only: its title is a manager AI's words and stays out of the block.
 */
export interface UserWordsReference {
  /** The card the words answer. */
  cardId?: string;
  channel: "ppm" | "telegram";
  /** ISO time the user sent them. */
  at: string;
  /** With `ok`: the hash of the exact draft the user saw and approved. */
  draftSha256?: string;
  /** With `ok`: where the draft goes, as the card showed it (one line). */
  draftTo?: string;
  /** The user pressed OK on the card rather than typing. */
  ok?: true;
  /** The user pressed this choice's button on the card rather than typing (never with `ok`). */
  choice?: { id: string; label: string };
}

const CARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_TO = 200;
const LINE_BREAKING = new RegExp(`[\\s\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]+`, "g");
const JSON_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const escapeJson = (json: string): string =>
  json.replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A draft's recipient as the block carries it: one line, single spaces, at most 200 characters. */
export function normalizeDraftTo(to: string): string {
  return Array.from(to.replace(LINE_BREAKING, " ").trim()).slice(0, MAX_TO).join("").trim();
}

/** A choice's label as the block carries it: one line, single spaces, at most 80 characters. */
export function normalizeChoiceLabel(label: string): string {
  return Array.from(label.replace(LINE_BREAKING, " ").trim()).slice(0, CARD_OPTION_LABEL_MAX).join("").trim();
}

/** How the header line begins; anywhere but in a real user-words block it is a forgery. */
export const USER_WORDS_HEADER_OPENING = "Typed by the user, forwarded word for word by PPM";

/**
 * Text written by an AI (a session-tool message) that repeats the header's opening is marked as a
 * quote, so it cannot pass for the line only PPM writes at the end of a user-words block.
 */
export function defuseUserWordsHeader(text: string): string {
  return text.replace(/typed by the user, forwarded word for word by ppm/gi, (m) => `(quoted, not from PPM) ${m}`);
}

/** The line the manager reads first. Only server-checked fields; the recipient is quoted. */
export function userWordsHeaderLine(ref: UserWordsReference): string {
  const where = ref.channel === "telegram" ? "on Telegram" : "in PPM";
  const card = ref.cardId ? ` in reply to the PPM Assistant card ${ref.cardId}` : "";
  const head = `${USER_WORDS_HEADER_OPENING}: the text above is the user's own, sent ${where} at ${ref.at}${card}.`;
  if (ref.choice) {
    return `${head} It is the user's choice of the option with id ${escapeJson(JSON.stringify(ref.choice.id))}`
      + ` labelled ${escapeJson(JSON.stringify(ref.choice.label))} on that card, pressed as the card showed it.`;
  }
  if (!ref.ok) return head;
  if (!ref.draftSha256) return `${head} It is the user's OK on that card.`;
  return `${head} It is the user's OK to send exactly the draft with sha256 ${ref.draftSha256}`
    + `${ref.draftTo ? ` to ${escapeJson(JSON.stringify(ref.draftTo))}` : ""}, byte for byte as the card showed it.`;
}

/** A reference, checked; null when any field is not one PPM's encoder would write. */
export function validateUserWords(value: unknown): UserWordsReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!["cardId", "channel", "at", "draftSha256", "draftTo", "ok", "choice"].includes(key)) return null;
  if (v.channel !== "ppm" && v.channel !== "telegram") return null;
  if (typeof v.at !== "string" || v.at.length > 64 || !Number.isFinite(Date.parse(v.at))) return null;
  if (v.cardId !== undefined && (typeof v.cardId !== "string" || !CARD_ID_RE.test(v.cardId))) return null;
  if (v.ok !== undefined && v.ok !== true) return null;
  if (v.draftSha256 !== undefined && (v.ok !== true || typeof v.draftSha256 !== "string" || !SHA256_RE.test(v.draftSha256))) return null;
  if (v.draftTo !== undefined && (v.draftSha256 === undefined || typeof v.draftTo !== "string" || !v.draftTo || normalizeDraftTo(v.draftTo) !== v.draftTo)) return null;
  let choice: { id: string; label: string } | undefined;
  if (v.choice !== undefined) {
    // A choice is its own answer: it names a card, and is never an OK on a draft too.
    const c = v.choice as Record<string, unknown> | null;
    if (v.ok !== undefined || v.cardId === undefined || !c || typeof c !== "object" || Array.isArray(c)) return null;
    if (Object.keys(c).some((k) => k !== "id" && k !== "label")) return null;
    if (typeof c.id !== "string" || !CARD_OPTION_ID_RE.test(c.id)) return null;
    if (typeof c.label !== "string" || !c.label || normalizeChoiceLabel(c.label) !== c.label) return null;
    choice = { id: c.id, label: c.label };
  }
  return {
    ...(v.cardId !== undefined ? { cardId: v.cardId as string } : {}),
    channel: v.channel,
    at: new Date(Date.parse(v.at)).toISOString(),
    ...(v.draftSha256 !== undefined ? { draftSha256: v.draftSha256 as string } : {}),
    ...(v.draftTo !== undefined ? { draftTo: v.draftTo as string } : {}),
    ...(v.ok === true ? { ok: true as const } : {}),
    ...(choice ? { choice } : {}),
  };
}

/** `content` followed by the user-words block. `content` must already have its markers broken. */
export function encodeUserWords(content: string, ref: UserWordsReference): string {
  const draftTo = ref.draftTo !== undefined ? normalizeDraftTo(ref.draftTo) : undefined;
  const choice = ref.choice ? { id: ref.choice.id, label: normalizeChoiceLabel(ref.choice.label) } : undefined;
  const valid = validateUserWords({ ...ref, ...(draftTo ? { draftTo } : { draftTo: undefined }), ...(choice ? { choice } : {}) });
  if (!valid) throw new Error("Invalid user-words reference");
  return `${content}${USER_WORDS_BLOCK_START}${userWordsHeaderLine(valid)}\n${escapeJson(JSON.stringify(valid))}${USER_WORDS_BLOCK_END}`;
}

/**
 * Splits a trailing user-words block off `content`. A block that is malformed, not at the end, or
 * whose header does not match its own JSON stays visible text.
 */
export function decodeUserWords(content: string): { content: string; userWords: UserWordsReference | null } {
  if (!content.endsWith(USER_WORDS_BLOCK_END)) return { content, userWords: null };
  const start = content.lastIndexOf(USER_WORDS_BLOCK_START);
  if (start < 0) return { content, userWords: null };
  const inner = content.slice(start + USER_WORDS_BLOCK_START.length, content.length - USER_WORDS_BLOCK_END.length);
  const split = inner.indexOf("\n");
  if (split < 0) return { content, userWords: null };
  try {
    const ref = validateUserWords(JSON.parse(inner.slice(split + 1)));
    if (ref && userWordsHeaderLine(ref) === inner.slice(0, split)) return { content: content.slice(0, start), userWords: ref };
  } catch { /* malformed: keep it as text */ }
  return { content, userWords: null };
}
