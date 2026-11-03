/**
 * Puts `turnId` and `turnN` on the messages a history path returns, from the session's turn index.
 *
 * Claude history mostly comes from the SDK's `getSessionMessages`, whose records carry no
 * `promptId`, so a message is found in the index by its record uuid (`sdkUuid`) instead. A message
 * the index has no uuid for — merged, synthesized, or written after the scan — takes the turn of
 * the message before it, the way every record belongs to the newest prompt by file position. The
 * one exception is a real prompt the index does not know: it opened a turn the index has not seen
 * yet, so it and everything after it stay unstamped until a known message comes along. Giving it
 * the previous turn would put the new question, and its answers, in a turn that ended before it.
 *
 * Codex messages already carry their native turn id from the parser; the index maps it to the
 * turn a person sees (a prompt-less turn, such as a manual compaction, belongs to the one before).
 * Copies a compaction wrote back are synthetic and get no turn at all.
 *
 * Never fails a history: an index that cannot be read leaves the messages as they were.
 */
import type { ChatMessage } from "../../types/chat.ts";
import { isRealPromptMessage } from "../../shared/user-prompt-kind.ts";
import { createLogger } from "../logger.ts";
import { turnLookup, type SessionRef } from "./session-turn-index.service.ts";
import { SessionTurnError, type TurnStamp } from "./session-turn-types.ts";

const log = createLogger("session-turns");

export type TurnLookup = (key: string) => TurnStamp | undefined;

/**
 * What stamping a history can be given: the session's lookup; none, when this project has no turn
 * index for the session (a provider without one, or a transcript the project does not own — a
 * standing answer); or `failed` when reading the index went wrong (a locked or vanished file),
 * which the next ask may not repeat.
 */
export type LoadedTurnLookup = { lookup?: TurnLookup; failed: boolean };

function apply(msg: ChatMessage, stamp: TurnStamp): void {
  msg.turnId = stamp.turnId;
  msg.turnN = stamp.n;
}

/** Claude: by record uuid, else the turn of the message before it — never onto an unknown prompt. */
export function stampClaudeMessages(messages: ChatMessage[], lookup: TurnLookup): void {
  let last: TurnStamp | undefined;
  for (const msg of messages) {
    const own = msg.sdkUuid ? lookup(msg.sdkUuid) : undefined;
    if (own) last = own;
    else if (isRealPromptMessage(msg)) last = undefined;
    if (last) apply(msg, last);
  }
}

/**
 * Codex: by native turn id. An id the index does not know yet (the rollout behind the live view)
 * is left as it is — it is that turn's own id, which the index will list once it catches up.
 */
export function stampCodexMessages(messages: ChatMessage[], lookup: TurnLookup): void {
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

/** The session's turn lookup. Never throws; a failure is logged and reported as `failed`. */
export async function loadTurnLookup(ref: SessionRef): Promise<LoadedTurnLookup> {
  try {
    return { lookup: await turnLookup(ref), failed: false };
  } catch (e) {
    const standing = e instanceof SessionTurnError;
    log.debug(`session=${ref.sessionId} turns not stamped: ${(e as Error).message}`);
    return { failed: !standing };
  }
}

/** Stamps `messages` in place with a lookup already loaded. */
export function applyTurnStamps(providerId: string, messages: ChatMessage[], loaded: LoadedTurnLookup): void {
  if (!loaded.lookup) return;
  if (providerId === "codex") stampCodexMessages(messages, loaded.lookup);
  else stampClaudeMessages(messages, loaded.lookup);
}

/** Stamps `messages` in place and returns them. */
export async function stampSessionTurns(ref: SessionRef, messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!messages.length) return messages;
  applyTurnStamps(ref.providerId, messages, await loadTurnLookup(ref));
  return messages;
}
