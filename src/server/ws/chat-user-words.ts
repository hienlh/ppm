/**
 * The server's door for the user's own words forwarded from a PPM Assistant card into the card's
 * manager chat: delivered like any message (the same entry, echo, consumer and replay), with the
 * user-words block PPM built after it, and no other block.
 *
 * Server-internal: only `forward-verbatim.ts` reaches it, after it checked the card, the person's
 * action and the card's status. The text is neutralized here as at every other door (markers
 * broken, a leading `/` defused), so the only block that decodes is the one built from `userWords`.
 */
import { encodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import { defuseUserWordsHeader, type UserWordsReference } from "../../shared/user-words-block.ts";
import { neutralizePpmTags } from "../../services/assistant-watch/watch-event-text.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";
import { getSessionDesignSlug, getSessionProvider, resolveMigratedSession } from "../../services/db.service.ts";
import { isAssistantSession } from "../../services/assistant/assistant-session.ts";
import { chatLifecycle } from "../../services/chat-control/chat-lifecycle.ts";
import { createLogger } from "../../services/logger.ts";
import { ensureSessionEntry, startCleanupTimer, submitToSession, withSessionLock } from "./chat.ts";

const log = createLogger("chat-user-words");

export interface DeliverUserWordsInput {
  targetSessionId: string;
  providerId: string;
  projectName: string;
  projectPath: string;
  /** What the user typed, exactly; "OK" for an OK. */
  text: string;
  userWords: UserWordsReference;
  /**
   * Whether the words answer the request the chat waits on (a reply to an approval or question
   * card): it is then refused, the way typing in that chat refuses it. Otherwise the words wait
   * behind any request, as a message from another session does.
   */
  supersede: boolean;
}

/**
 * `delivered` says how the words went in: a turn `started` with them or they were `inserted` into
 * the running one, or they are `queued` behind it (a waiting approval) and reach the model only
 * when the next turn opens — named by `clientMessageId` in that turn's `turn_started`.
 */
export type DeliverUserWordsResult =
  | { ok: true; content: string; sessionId: string; delivered: SessionDelivery; clientMessageId: string }
  | { ok: false; error: string };

/** A leading `/` would run as a slash command the user never typed into that chat. */
const defuseCommand = (text: string): string => (text.trimStart().startsWith("/") ? `${String.fromCharCode(0x200b)}${text}` : text);

export async function deliverUserWords(input: DeliverUserWordsInput): Promise<DeliverUserWordsResult> {
  if (!input.text.trim()) return { ok: false, error: "The message is empty" };
  const target = resolveMigratedSession(input.targetSessionId);
  if (isAssistantSession(target)) return { ok: false, error: "A PPM Assistant session takes the user's words from its own chat" };
  if (getSessionDesignSlug(target)) return { ok: false, error: "A design chat does not take forwarded words" };
  const stored = getSessionProvider(target);
  if (stored && stored !== input.providerId) return { ok: false, error: `That chat runs on ${stored}, not ${input.providerId}` };

  // Pasted text (an email, a log) may carry a loose PPM-looking tag or a copy of the user-words
  // header: both are defused, so the one block PPM builds below is the only one there.
  const content = encodeMessageBlocks(defuseCommand(defuseUserWordsHeader(neutralizePpmTags(input.text))), { userWords: input.userWords, ownProject: input.projectName || undefined });
  const clientMessageId = `card-${crypto.randomUUID()}`;
  return withSessionLock(target, async () => {
    const entry = ensureSessionEntry(target, input.providerId, input.projectPath, input.projectName);
    if (entry.providerId !== input.providerId) {
      if (entry.phase !== "idle" || entry.isStreamingActive) return { ok: false, error: `That chat is running on ${entry.providerId}` };
      entry.providerId = input.providerId;
    }
    const previousOrigin = entry.turnOrigin;
    entry.turnOrigin = "session";
    const result = await submitToSession(target, entry, content, {
      origin: "session",
      clientMessageId,
      priority: "next",
      receivedAt: Date.now(),
      supersedePendingApproval: input.supersede,
      echoOnHandOff: true,
    });
    if (!result.ok) {
      entry.turnOrigin = previousOrigin;
      if (entry.clients.size === 0 && !entry.isStreamingActive) startCleanupTimer(target);
      log.warn(`session=${target} the user's words from card ${input.userWords.cardId ?? "-"} were not delivered: ${result.error}`);
      return { ok: false, error: result.error };
    }
    log.info(`session=${target} the user's words from card ${input.userWords.cardId ?? "-"} ${result.delivered} (${input.userWords.channel})`);
    chatLifecycle.emit("user_message", {
      sessionId: target, text: content, origin: "session", imageCount: 0,
      projectName: entry.projectName ?? input.projectName, providerId: entry.providerId,
    });
    return { ok: true, content, sessionId: target, delivered: result.delivered, clientMessageId };
  });
}
