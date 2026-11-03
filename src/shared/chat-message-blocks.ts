import { decodeReply, encodeReply, type ReplyReference } from "./chat-reply";
import { decodeTurnRefs, encodeTurnRefs, type TurnReference } from "./chat-turn-ref";

/**
 * The structured blocks PPM appends to a user message, in their fixed order: the text the person
 * typed, then a turn-references block, then a reply block. The reply block stays last, so a build
 * that only knows `decodeReply` still finds it.
 *
 * Every reader of a stored user message goes through {@link decodeMessageBlocks}, and every writer
 * through {@link encodeMessageBlocks}, which neutralizes the body first: only PPM's own encoder
 * can produce a block that decodes, whatever the text came from — a person, a Jira ticket, a
 * group-chat peer or a schedule.
 */

export interface MessageBlocks {
  content: string;
  replyTo: ReplyReference | null;
  turnRefs: TurnReference[] | null;
}

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BLOCK_MARKER = /<(\/?)(ppm-(?:reply|turnrefs)-v1)/gi;

/**
 * Breaks every opening or closing marker of a PPM message block in `text` with a zero-width space
 * after `<` (or `</`), so no block can form from it. Idempotent; the text still reads the same.
 */
export function neutralizeBlockMarkers(text: string): string {
  return text.replace(BLOCK_MARKER, (_m, slash: string, name: string) => `<${slash}${ZERO_WIDTH_SPACE}${name}`);
}

/** The body and every block of a stored user message; a block that does not decode stays text. */
export function decodeMessageBlocks(content: string): MessageBlocks {
  const reply = decodeReply(content);
  const refs = decodeTurnRefs(reply.content);
  return { content: refs.content, replyTo: reply.replyTo, turnRefs: refs.turnRefs };
}

/**
 * `body` with its blocks, in order. The body is neutralized first, so it must be the text alone —
 * pass `decodeMessageBlocks(stored).content` when re-encoding a stored message.
 */
export function encodeMessageBlocks(
  body: string,
  blocks?: { turnRefs?: readonly TurnReference[] | null; replyTo?: ReplyReference | null },
): string {
  const withRefs = encodeTurnRefs(neutralizeBlockMarkers(body), blocks?.turnRefs);
  return encodeReply(withRefs, blocks?.replyTo);
}
