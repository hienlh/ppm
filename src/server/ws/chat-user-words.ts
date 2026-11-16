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
import type { TaskReference } from "../../shared/chat-task-ref.ts";
import { neutralizePpmTags } from "../../services/assistant-watch/watch-event-text.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";
import type { ReplyImage } from "../../services/assistant-cards/card-reply-images.ts";
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
  /** What the user typed, exactly; "OK" for an OK. May be empty when `images` carries the reply. */
  text: string;
  /**
   * Images sent with a reply, each already checked and written by the server under a name it
   * chose (`card-reply-images.ts`): the payload goes to Claude, the file to Codex, and a marker
   * naming the file opens the message so the chat draws it as the composer's images are drawn.
   */
  images?: readonly ReplyImage[];
  userWords: UserWordsReference;
  /**
   * The task the words are about (a Telegram message sent to a task's chat), read from the task
   * store by the caller; written as its own block after the user-words block.
   */
  taskRefs?: readonly TaskReference[] | null;
  /**
   * Whether the words answer the request the chat waits on (a reply to an approval or question
   * card): it is then refused, the way typing in that chat refuses it. Otherwise the words wait
   * behind any request, as a message from another session does.
   */
  supersede: boolean;
  /**
   * The id to send the words under, chosen by the caller so it can follow the turn they open;
   * anything but a `card-<uuid>` is replaced, since the delivery reconciler keys on that prefix.
   */
  clientMessageId?: string;
}

/**
 * `delivered` says how the words went in: a turn `started` with them or they were `inserted` into
 * the running one, or they are `queued` behind it (a waiting approval) and reach the model only
 * when the next turn opens — named by `clientMessageId` in that turn's `turn_started`.
 */
export type DeliverUserWordsResult =
  | { ok: true; content: string; sessionId: string; delivered: SessionDelivery; clientMessageId: string }
  | { ok: false; error: string };

const CARD_CLIENT_ID_RE = /^card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A leading `/` would run as a slash command the user never typed into that chat. */
const defuseCommand = (text: string): string => (text.trimStart().startsWith("/") ? `${String.fromCharCode(0x200b)}${text}` : text);

/**
 * A line of the user's text shaped like an attachment marker would be drawn, and read by the
 * model, as an image PPM attached. Not only at the very start: the display strips a leading code
 * fence or `<ide_opened_file>` tag before it looks for markers, which can bring a later line to
 * the front. A zero-width space before the bracket of every such line keeps it the user's text
 * (it survives the display's trim, which removes whitespace only).
 */
const defuseAttachmentMarkers = (text: string): string =>
  // Any whitespace but a line break before the bracket: the display's trim removes all of it.
  text.replace(/^([^\S\r\n]*)\[Attached (image|file)/gm, `$1${String.fromCharCode(0x200b)}[Attached $2`);

/** The marker the composer writes for an image whose payload rides along with the message. */
const inlineImageMarker = (path: string): string => `[Attached image (contents included in this message): ${path}]`;

/**
 * The stored message: one marker per image (built by the server from the paths it wrote, after
 * the text was neutralized, so the text can neither forge nor alter them), then the user's words,
 * then the user-words block — the only block that decodes.
 */
export function userWordsContent(input: Pick<DeliverUserWordsInput, "text" | "images" | "userWords" | "taskRefs" | "projectName">): string {
  // Pasted text (an email, a log) may carry a loose PPM-looking tag or a copy of the user-words
  // header: both are defused, so the one block PPM builds below is the only one there.
  const words = defuseCommand(defuseAttachmentMarkers(defuseUserWordsHeader(neutralizePpmTags(input.text))));
  const markers = (input.images ?? []).map((img) => inlineImageMarker(img.path));
  const body = markers.length ? `${markers.join("\n\n")}\n\n${words}` : words;
  return encodeMessageBlocks(body, { userWords: input.userWords, taskRefs: input.taskRefs ?? null, ownProject: input.projectName || undefined });
}

/** For the log: the card the words answer, or the task they are about. */
const wordsFrom = (input: DeliverUserWordsInput): string =>
  input.userWords.cardId ? `from card ${input.userWords.cardId}` : input.taskRefs?.length ? `about task ${input.taskRefs[0]!.ref}` : "(no card)";

export async function deliverUserWords(input: DeliverUserWordsInput): Promise<DeliverUserWordsResult> {
  const images = input.images ?? [];
  if (!input.text.trim() && !images.length) return { ok: false, error: "The message is empty" };
  const target = resolveMigratedSession(input.targetSessionId);
  if (isAssistantSession(target)) return { ok: false, error: "A PPM Assistant session takes the user's words from its own chat" };
  if (getSessionDesignSlug(target)) return { ok: false, error: "A design chat does not take forwarded words" };
  const stored = getSessionProvider(target);
  if (stored && stored !== input.providerId) return { ok: false, error: `That chat runs on ${stored}, not ${input.providerId}` };

  const content = userWordsContent(input);
  const clientMessageId = input.clientMessageId && CARD_CLIENT_ID_RE.test(input.clientMessageId)
    ? input.clientMessageId : `card-${crypto.randomUUID()}`;
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
      // As the composer sends them: the payloads for Claude, the files for Codex.
      ...(images.length ? {
        images: images.map(({ data, mediaType }) => ({ data, mediaType })),
        imagePaths: images.map((img) => img.path),
      } : {}),
    });
    if (!result.ok) {
      entry.turnOrigin = previousOrigin;
      if (entry.clients.size === 0 && !entry.isStreamingActive) startCleanupTimer(target);
      log.warn(`session=${target} the user's words ${wordsFrom(input)} were not delivered: ${result.error}`);
      return { ok: false, error: result.error };
    }
    log.info(`session=${target} the user's words ${wordsFrom(input)} ${result.delivered} (${input.userWords.channel})`);
    chatLifecycle.emit("user_message", {
      sessionId: target, text: content, origin: "session", imageCount: images.length,
      projectName: entry.projectName ?? input.projectName, providerId: entry.providerId,
    });
    return { ok: true, content, sessionId: target, delivered: result.delivered, clientMessageId };
  });
}
