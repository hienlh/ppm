/**
 * Puts `turnId` and `turnN` on the messages a history path returns, from the session's turn index.
 *
 * Claude history mostly comes from the SDK's `getSessionMessages`, whose records carry no
 * `promptId`, so a message is found in the index by its record uuid (`sdkUuid`) instead. A message
 * the index has no uuid for — merged, synthesized, or written after the scan — takes the turn of
 * the message before it, the way every record belongs to the newest prompt by file position.
 *
 * Codex messages already carry their native turn id from the parser; the index maps it to the
 * turn a person sees (a prompt-less turn, such as a manual compaction, belongs to the one before).
 * Copies a compaction wrote back are synthetic and get no turn at all.
 *
 * Never fails a history: an index that cannot be read leaves the messages as they were.
 */
import type { ChatMessage } from "../../types/chat.ts";
import { createLogger } from "../logger.ts";
import { turnLookup, type SessionRef } from "./session-turn-index.service.ts";
import type { TurnStamp } from "./session-turn-types.ts";

const log = createLogger("session-turns");

type Lookup = (key: string) => TurnStamp | undefined;

function apply(msg: ChatMessage, stamp: TurnStamp): void {
  msg.turnId = stamp.turnId;
  msg.turnN = stamp.n;
}

/** Claude: by record uuid, else the turn of the message before it. */
export function stampClaudeMessages(messages: ChatMessage[], lookup: Lookup): void {
  let last: TurnStamp | undefined;
  for (const msg of messages) {
    const own = msg.sdkUuid ? lookup(msg.sdkUuid) : undefined;
    if (own) last = own;
    if (last) apply(msg, last);
  }
}

/**
 * Codex: by native turn id. An id the index does not know yet (the rollout behind the live view)
 * is left as it is — it is that turn's own id, which the index will list once it catches up.
 */
export function stampCodexMessages(messages: ChatMessage[], lookup: Lookup): void {
  for (const msg of messages) {
    if (msg.synthetic) {
      delete msg.turnId;
      delete msg.turnN;
      continue;
    }
    const stamp = msg.turnId ? lookup(msg.turnId) : undefined;
    if (stamp) apply(msg, stamp);
  }
}

/** Stamps `messages` in place and returns them. */
export async function stampSessionTurns(ref: SessionRef, messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!messages.length) return messages;
  try {
    const lookup = await turnLookup(ref);
    if (ref.providerId === "codex") stampCodexMessages(messages, lookup);
    else stampClaudeMessages(messages, lookup);
  } catch (e) {
    log.debug(`session=${ref.sessionId} turns not stamped: ${(e as Error).message}`);
  }
  return messages;
}
