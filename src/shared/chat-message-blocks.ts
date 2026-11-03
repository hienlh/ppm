import { decodeReply, encodeReply, REPLY_BLOCK_END, REPLY_BLOCK_START, type ReplyReference } from "./chat-reply";
import {
  decodeTurnRefs, encodeTurnRefs, TURN_REFS_BLOCK_END, TURN_REFS_BLOCK_START, type TurnReference,
} from "./chat-turn-ref";

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

/**
 * The only strings a decoder accepts as a block's start or end, each with the form it is broken
 * into: a zero-width space after the `<`. Every block must end with its exact end sentinel and
 * contain its exact start sentinel, so breaking these and nothing else is enough.
 */
const SENTINELS: ReadonlyArray<readonly [string, string]> = [
  REPLY_BLOCK_START, REPLY_BLOCK_END, TURN_REFS_BLOCK_START, TURN_REFS_BLOCK_END,
].map((s) => [s, s.replace("<", `<${ZERO_WIDTH_SPACE}`)] as const);

/**
 * Breaks every exact start and end sentinel of a PPM message block in `text`, so no block can form
 * from it. Anything else — a lone `<ppm-reply-v1>` tag in pasted code, another case, another
 * spacing — is left exactly as written, since no decoder reads it as a block. Idempotent.
 */
export function neutralizeBlockMarkers(text: string): string {
  let out = text;
  for (const [sentinel, broken] of SENTINELS) if (out.includes(sentinel)) out = out.split(sentinel).join(broken);
  return out;
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
