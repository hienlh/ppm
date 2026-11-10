import { decodeReply, encodeReply, REPLY_BLOCK_END, REPLY_BLOCK_START, type ReplyReference } from "./chat-reply";
import {
  decodeTurnRefs, encodeTurnRefs, TURN_REFS_BLOCK_END, TURN_REFS_BLOCK_START, TURN_REFS_LEGACY_BLOCK_START,
  type TurnReference,
} from "./chat-turn-ref";
import {
  decodeFromSession, encodeFromSession, FROM_SESSION_BLOCK_END, FROM_SESSION_BLOCK_START, type FromSessionReference,
} from "./chat-from-session";
import {
  decodeProvenance, encodeProvenance, PROVENANCE_BLOCK_END, PROVENANCE_BLOCK_START, USER_WORDS_BLOCK_END,
  USER_WORDS_BLOCK_START, type AssistantProvenance,
} from "./assistant-provenance";

/**
 * The structured blocks PPM appends to a user message, in their fixed order: the text the person
 * (or another session's AI) wrote, then — on a PPM Assistant message only — a provenance block,
 * then a from-session block, then a turn-references block, then a reply block. The reply block
 * stays last, so a build that only knows `decodeReply` still finds it.
 *
 * Every reader of a stored user message goes through {@link decodeMessageBlocks}, and every writer
 * through {@link encodeMessageBlocks}, which neutralizes the body first: only PPM's own encoder
 * can produce a block that decodes, whatever the text came from — a person, a Jira ticket, a
 * group-chat peer, a schedule or another session.
 */

export interface MessageBlocks {
  content: string;
  replyTo: ReplyReference | null;
  turnRefs: TurnReference[] | null;
  /** Set when another PPM session's AI sent the message; only the server encodes one. */
  fromSession: FromSessionReference | null;
  /** How the PPM Assistant's turn that sent the message started; only with an Assistant sender. */
  provenance: AssistantProvenance | null;
}

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * The only strings a decoder accepts as a block's start or end, each with the form it is broken
 * into: a zero-width space after the `<`. Every block must end with its exact end sentinel and
 * contain its exact start sentinel, so breaking these and nothing else is enough.
 */
const SENTINELS: ReadonlyArray<readonly [string, string]> = [
  REPLY_BLOCK_START, REPLY_BLOCK_END, TURN_REFS_BLOCK_START, TURN_REFS_LEGACY_BLOCK_START, TURN_REFS_BLOCK_END,
  FROM_SESSION_BLOCK_START, FROM_SESSION_BLOCK_END, PROVENANCE_BLOCK_START, PROVENANCE_BLOCK_END,
  USER_WORDS_BLOCK_START, USER_WORDS_BLOCK_END,
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
  const from = decodeFromSession(refs.content);
  // A provenance block means something only on a message the PPM Assistant sent.
  const prov = from.fromSession?.kind === "assistant" ? decodeProvenance(from.content) : { content: from.content, provenance: null };
  return { content: prov.content, replyTo: reply.replyTo, turnRefs: refs.turnRefs, fromSession: from.fromSession, provenance: prov.provenance };
}

/**
 * `body` with its blocks, in order. The body is neutralized first, so it must be the text alone —
 * pass `decodeMessageBlocks(stored).content` when re-encoding a stored message. Text that came from
 * a browser must never be re-encoded with a `fromSession`: only the server's session tools may say
 * a message came from another session. `ownProject` is the project of the chat the message is for,
 * so the turn-references block can tell its AI which turns are in its own project.
 */
export function encodeMessageBlocks(
  body: string,
  blocks?: {
    turnRefs?: readonly TurnReference[] | null;
    replyTo?: ReplyReference | null;
    fromSession?: FromSessionReference | null;
    /** Only with a `fromSession` of kind `assistant`; written by the session tools alone. */
    provenance?: AssistantProvenance | null;
    ownProject?: string;
  },
): string {
  if (blocks?.provenance && blocks.fromSession?.kind !== "assistant") throw new Error("A provenance block needs a PPM Assistant sender");
  const withProv = encodeProvenance(neutralizeBlockMarkers(body), blocks?.provenance);
  const withFrom = encodeFromSession(withProv, blocks?.fromSession);
  const withRefs = encodeTurnRefs(withFrom, blocks?.turnRefs, blocks?.ownProject);
  return encodeReply(withRefs, blocks?.replyTo);
}
