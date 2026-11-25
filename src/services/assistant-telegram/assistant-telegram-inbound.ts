/**
 * What arrives from Telegram, handled one chat at a time.
 *
 * Every update of a chat runs after the one before it has finished, in the order Telegram sent
 * them: a message typed and a button pressed in the same moment must not race, because a typed
 * message cancels the card the button answers. Chats do not wait for each other.
 *
 * Consecutive messages are gathered for `debounce_ms` and sent as one (people write in bursts).
 * Anything else — a command, a button — first sends what was gathered, so order still holds.
 * An update counts as handed on only once it reached the Assistant (or was answered); until
 * then the poll loop does not confirm it to Telegram, so a crash mid-debounce loses nothing.
 */
import { handleConnectMessage } from "../telegram-connect.service.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "../telegram/telegram-types.ts";
import { checkAccess, refusalText } from "./assistant-telegram-access.ts";
import { BindingError, ensureBoundSession } from "./assistant-telegram-binding.ts";
import { parseCommand, quietStatusHtml, runCommand } from "./assistant-telegram-commands.ts";
import { setQuietWhileInPpm } from "./assistant-telegram-silence.ts";
import { fetchPhoto, fetchPhotos } from "./assistant-telegram-photos.ts";
import { MAX_REPLY_IMAGE_BYTES, REPLY_IMAGE_SIZE_TEXT } from "../assistant-cards/card-reply-images.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import type { BridgeAction, ManagerCardPress, SettingsPress, TaskPress } from "./assistant-telegram-actions.ts";
import type { CardReplyMessage } from "./assistant-telegram-card-replies.ts";
import type { RelayedCard } from "./assistant-telegram-cards.ts";
import type { TypedAnswerMessage } from "./assistant-telegram-typed-answers.ts";
import { forwardedFrom, wrapForwarded, backlogQuestion, viaInlineBot } from "./assistant-telegram-inbound-text.ts";
import { quoteTelegramMessage, toReplyReference, type BotSource, type QuotedCard, type TelegramQuote } from "./assistant-telegram-reply-quote.ts";
import type { AnswerTurn } from "./assistant-telegram-own-answers.ts";
import type { TaskWordsAim, TaskWordsMessage } from "./assistant-telegram-task-message.ts";
import { TelegramVoiceMessages } from "./assistant-telegram-voice.ts";
import type { TelegramVoiceDeps } from "./assistant-telegram-voice-deps.ts";
import type { VoiceBundle, VoiceWordsAim } from "./assistant-telegram-voice-pending.ts";
import { encodeVoicePart, type VoicePart } from "../../shared/voice-message.ts";
import { rmSync } from "node:fs";
import {
  AUDIO_FORMAT_TEXT, audioFileExt, VOICE_FORWARDED_TEXT, VOICE_OLD_TEXT, voiceOffHtml, voiceRefusal,
} from "./assistant-telegram-voice-card.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** A message older than this was sent while PPM was off: asked about rather than run. */
export const BACKLOG_AGE_MS = 10 * 60_000;
const MAX_IMAGES = 5;
const MAX_PENDING_BACKLOG = 50;
/**
 * How long an album replying to a card waits for its next photo. Telegram sends each photo of an
 * album as its own update, close together; the reply is sent once, with all of them.
 */
export const CARD_ALBUM_DEBOUNCE_MS = 1200;
/** What a photo-only reply to a card sent while PPM was off is told: such a reply is not kept. */
export const BACKLOG_PHOTO_ONLY_NOTE = "A photo sent while PPM was off cannot answer a card. Send it again as a reply to the card.";
/** Said beside the backlog question when such a reply also had words: only they are kept. */
export const BACKLOG_PHOTO_DROPPED_NOTE = "The photo sent with it while PPM was off is not kept; only the words can be sent. Send the photo again as a reply to the card if it matters.";

type Image = { data: string; mediaType: string };
/**
 * `quote`: what the user replied to, said once for the whole burst (see `message`). `voice`: a voice
 * message being read owns the burst, which then stays open until its transcript is ready.
 */
type Gathered = VoiceBundle;
/** An album replying to a card, gathered until its last photo has arrived. */
interface CardAlbum { groupId: string; replyTo: number; updateIds: number[]; messages: TelegramMessage[]; timer: ReturnType<typeof setTimeout> | null }

export interface InboundDeps {
  client: TelegramBotClient;
  token: string;
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  debounceMs: () => number;
  /** The update reached the Assistant or was answered: the poll loop may confirm it. */
  delivered: (updateId: number) => void;
  /** A button the inbound router does not own (a card's): the toast to show, after acting. */
  pressCard: (chatId: string, press: Extract<BridgeAction, { kind: "card" }>, group: string, cq: TelegramCallbackQuery) => string;
  /** `/sessions` picked a session. */
  switchSession: (chatId: string, sessionId: string) => string;
  /** `/status` shows a chat's waiting card here. */
  relayCard: (chatId: string, card: RelayedCard) => void;
  /** A button on one of the Assistant's own cards: the toast to show, after acting. */
  pressManagerCard?: (chatId: string, press: ManagerCardPress, group: string) => Promise<string>;
  /** A PPM Tasks button (`/tasks`, a created task, an Undo on a task card): the toast to show, after acting. */
  pressTask?: (chatId: string, press: TaskPress, group: string, cq: TelegramCallbackQuery) => Promise<string>;
  /** Undo on a settings card the Assistant's settings tools left: the toast to show, after acting. */
  pressSettings?: (chatId: string, press: SettingsPress, group: string) => Promise<string>;
  /** `/tasks [project]`. */
  showTasks?: (chatId: string, args: string, reply: (html: string) => void) => void;
  /**
   * Words for the chat working on a task: a reply to a task card, or the next message after
   * "Message about this task". `wants` decides, `take` sends and answers in the chat.
   */
  taskWords?: { wants(chatId: string, replyToMessageId?: number): TaskWordsAim | null; take(chatId: string, m: TaskWordsMessage, aim: TaskWordsAim): Promise<void> };
  /**
   * Words that may answer a question card (a reply to it, or the message after its ✏️ Other): what
   * to tell the user when a card took them or refused them, null when they are not for a card.
   */
  typedAnswer?: (chatId: string, m: TypedAnswerMessage) => string | null;
  /**
   * Whether words in a message arriving now would be taken by a question card (`typedAnswer` without
   * acting): asked for a voice message before it is read, so its transcript goes where typed words would.
   */
  wantsTypedAnswer?: (chatId: string, replyToMessageId?: number) => boolean;
  /** A message sent as a reply to a card's message: true when it answered the card. */
  replyToCard?: (chatId: string, m: CardReplyMessage) => Promise<boolean>;
  /** Whether this message of this chat shows one of the Assistant's cards. */
  isCardMessage?: (chatId: string, messageId: number) => boolean;
  /** The card a message of this chat showed, whatever became of it; for the quote of a reply. */
  cardOf?: (chatId: string, messageId: number) => QuotedCard | null;
  /** The Assistant turn a bot message of this chat was an answer of; null for any other bot message. */
  answerOf?: (chatId: string, messageId: number) => AnswerTurn | null;
  /** The session the chat talks to now, for telling this conversation's answers from another's. */
  boundSessionOf?: (chatId: string) => string | null;
  now?: () => number;
  /** How long an album replying to a card waits for its next photo; {@link CARD_ALBUM_DEBOUNCE_MS} by default. */
  albumDebounceMs?: () => number;
  /** Voice messages (Whisper + clean-up); without it a voice message is refused as before. */
  voice?: TelegramVoiceDeps;
}

interface ChatLane { chain: Promise<void>; gathered: Gathered | null; timer: ReturnType<typeof setTimeout> | null; album: CardAlbum | null }

export class AssistantTelegramInbound {
  private readonly lanes = new Map<string, ChatLane>();
  private readonly refused = new Set<string>();
  private readonly backlog = new Map<string, { chatId: string; text: string; images: Image[]; card?: CardReplyMessage; quote?: TelegramQuote }>();
  private readonly now: () => number;
  private readonly voice: TelegramVoiceMessages | null;
  /** When each chat last sent the Assistant a photo, so a voice arriving after it says it follows it. */
  private readonly photoSentAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly deps: InboundDeps) {
    this.now = deps.now ?? Date.now;
    this.voice = deps.voice ? new TelegramVoiceMessages({
      client: deps.client, queue: deps.queue, codes: deps.codes, deps: deps.voice, now: this.now,
      reply: (chatId, html) => this.reply(chatId, html),
      onLane: (chatId, work) => this.onLane(chatId, work),
      release: (chatId, bundle) => this.release(chatId, bundle),
      deliverBundle: (chatId, bundle, voicePart) => this.deliverBundle(chatId, bundle, voicePart),
      confirm: (bundle) => { for (const id of bundle.updateIds.splice(0)) this.deps.delivered(id); },
      recentPhotoAt: (chatId) => {
        const at = this.photoSentAt.get(chatId);
        return at !== undefined && this.now() - at < BACKLOG_AGE_MS ? new Date(at).toTimeString().slice(0, 5) : null;
      },
    }) : null;
  }

  dispatch(update: TelegramUpdate): void {
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId === undefined || this.stopped) return this.deps.delivered(update.update_id);
    this.onLane(String(chatId), () => this.handle(String(chatId), update));
  }

  /** Waits for every chat's work queued so far (tests, a clean stop). */
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const pending = [...this.lanes.values()];
      await Promise.all(pending.map((l) => l.chain));
      // A voice answering a card is read in a bundle of its own, held by no lane.
      if ([...this.lanes.values()].every((l) => !l.gathered && !l.timer && !l.album) && !this.voice?.reading()) return;
      await Bun.sleep(10);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const chatId of [...this.lanes.keys()]) this.forgetChat(chatId);
    this.voice?.stop();
  }

  /** Drops what a chat had gathered; its updates are confirmed so they are not read again. */
  forgetChat(chatId: string): void {
    const lane = this.lanes.get(chatId);
    if (lane?.timer) clearTimeout(lane.timer);
    if (lane?.album?.timer) clearTimeout(lane.album.timer);
    for (const id of [...lane?.gathered?.updateIds ?? [], ...lane?.album?.updateIds ?? []]) this.deps.delivered(id);
    if (lane) { lane.gathered = null; lane.timer = null; lane.album = null; }
    for (const [id, b] of this.backlog) if (b.chatId === chatId) this.backlog.delete(id);
    this.forgetRefusals(chatId);
    this.photoSentAt.delete(chatId);
    this.voice?.forgetChat(chatId);
  }

  private forgetRefusals(chatId: string): void {
    for (const key of [...this.refused]) if (key.startsWith(`${chatId}:`)) this.refused.delete(key);
  }

  private onLane(chatId: string, work: () => Promise<void>): void {
    const lane = this.lanes.get(chatId) ?? { chain: Promise.resolve(), gathered: null, timer: null, album: null };
    this.lanes.set(chatId, lane);
    const chain = lane.chain.then(work).catch((e) => log.warn(`Telegram chat ${chatId}: ${(e as Error)?.message ?? e}`));
    lane.chain = chain;
    // A lane exists only while it has work: anyone can write to a public bot, so one kept per
    // chat id ever seen — strangers refused at the door included — would grow without end.
    // Nothing queued after this work and nothing gathered means the next update starts a fresh
    // lane, and order still holds because this one has finished.
    void chain.then(() => {
      if (lane.chain === chain && !lane.gathered && !lane.timer && !lane.album && this.lanes.get(chatId) === lane) this.lanes.delete(chatId);
    });
  }

  private reply(chatId: string, html: string, markup?: InlineKeyboardMarkup): void {
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html, ...(markup ? { markup } : {}) }, { label: "reply" }));
  }

  private async handle(chatId: string, update: TelegramUpdate): Promise<void> {
    try {
      if (update.callback_query) {
        await this.flushAlbum(chatId);
        await this.flush(chatId);
        await this.press(chatId, update.callback_query);
      } else if (update.message) {
        if (await this.message(chatId, update.message, update.update_id)) return;
      }
    } catch (e) {
      log.warn(`Telegram update ${update.update_id} in chat ${chatId} failed: ${(e as Error)?.message ?? e}`);
    }
    this.deps.delivered(update.update_id);
  }

  /** True when the update was gathered (its delivery is reported on flush). */
  private async message(chatId: string, message: TelegramMessage, updateId: number): Promise<boolean> {
    const text = message.text ?? message.caption ?? "";
    // A tapped connect link connects the chat itself, so it comes before the access check.
    // The Assistant's link refuses a group itself (`privateOnly`), leaving the link unused.
    if (text.startsWith("/start") && await handleConnectMessage(message, this.deps.token,
      (id, html) => this.deps.client.sendMessage(id, html))) return false;

    const access = checkAccess(message.chat, message.from);
    if (!access.ok) {
      const key = `${chatId}:${access.refusal}`;
      if (!this.refused.has(key)) {
        // Bounded: strangers writing to a public bot must not grow this without end.
        if (this.refused.size >= 1000) this.refused.clear();
        this.refused.add(key);
        log.info(`Telegram message from chat ${chatId} refused: ${access.refusal}`);
        // Straight to the client: the send lane only writes to connected chats, and this one is not.
        await this.deps.client.sendMessage(chatId, refusalText(access.refusal));
      }
      return false;
    }
    // Allowed again (reconnected): a later refusal is worth saying once more.
    this.forgetRefusals(chatId);

    // The next photo of an album replying to a card joins it; anything else sends that album first.
    const album = this.lanes.get(chatId)?.album;
    if (album && message.media_group_id === album.groupId) {
      album.updateIds.push(updateId);
      album.messages.push(message);
      this.armAlbum(chatId, album);
      return true;
    }
    if (album) await this.flushAlbum(chatId);

    // Text a forward or an inline bot wrote is someone else's, whoever Telegram names as sender.
    const from = forwardedFrom(message) ?? viaInlineBot(message);
    // A forwarded "/stop" is someone else's text, not the owner's command.
    const command = from ? null : parseCommand(message.text);
    if (command) {
      await this.flush(chatId);
      await runCommand(command, {
        chatId,
        reply: (html, markup) => this.reply(chatId, html, markup),
        switchCode: (sessionId) => this.deps.codes.mint(chatId, `switch:${chatId}:${updateId}`, { kind: "switch", sessionId }),
        quietCode: (on) => this.deps.codes.mint(chatId, `quiet:${chatId}:${updateId}`, { kind: "quiet", on }),
        relayCard: (card) => this.deps.relayCard(chatId, card),
        ...(this.deps.showTasks ? { tasks: (args: string) => this.deps.showTasks!(chatId, args, (html) => this.reply(chatId, html)) } : {}),
      });
      return false;
    }

    // A reply to a voice message's review card replaces its transcript.
    if (this.voice?.replace(chatId, message)) return false;
    if ((message.voice || message.audio) && this.voice && this.deps.voice) {
      // Someone else's voice is not the user's words; with a caption, the caption still goes as text.
      if (from) {
        if (!(message.caption ?? "").trim()) {
          this.reply(chatId, escapeTelegramHtml(VOICE_FORWARDED_TEXT));
          return false;
        }
      } else if (!this.deps.voice.enabled()) {
        this.voiceOff(chatId, updateId);
        if (!(message.caption ?? "").trim()) return false;
      } else {
        return this.voiceMessage(chatId, message, updateId);
      }
    }

    // An answer in the user's own words to a chat's question card: a reply to it, or the message
    // after its ✏️ Other. One sent while PPM was off is not: it goes on and is asked about below.
    const repliedTo = message.reply_to_message?.message_id;
    if (this.deps.typedAnswer && this.now() - message.date * 1000 <= BACKLOG_AGE_MS) {
      const said = this.deps.typedAnswer(chatId, {
        text: message.text ?? message.caption ?? "",
        ...(repliedTo !== undefined ? { replyToMessageId: repliedTo } : {}),
        notTheUsers: !!from || !!message.via_bot,
        hasPhoto: !!message.photo?.length,
      });
      if (said !== null) {
        await this.flush(chatId);
        this.reply(chatId, said);
        return false;
      }
    }

    // A reply to one of the Assistant's cards answers that card, word for word, and is never merged
    // into a gathered message. One sent while PPM was off is asked about first, like any other.
    /** The photo, when the card-reply path already tried to fetch it (null: it could not be). */
    let prefetched: Image | null | undefined;
    if (repliedTo !== undefined && this.deps.replyToCard && this.deps.isCardMessage?.(chatId, repliedTo)) {
      await this.flush(chatId);
      if (message.media_group_id && message.photo?.length) {
        // The first photo of an album: the rest arrive as updates of their own, and the reply goes
        // once with all of them.
        const lane = this.lanes.get(chatId)!;
        lane.album = { groupId: message.media_group_id, replyTo: repliedTo, updateIds: [updateId], messages: [message], timer: null };
        this.armAlbum(chatId, lane.album);
        return true;
      }
      const answered = await this.answerCard(chatId, [message], repliedTo, updateId);
      if (answered.handled) return false;
      // The card could not be found after all: the message goes on to the Assistant below, with
      // the photo already fetched here rather than downloaded (and its failure reported) twice.
      if (answered.photosTried) prefetched = answered.images[0] ?? null;
    }

    // A reply to a task card, or the message after "Message about this task" (or "Ask manager"),
    // goes to the chat working on that task (or to the manager chat) rather than to the Assistant.
    // One sent while PPM was off is not: it is
    // asked about below, like any other, and goes to the Assistant if run.
    const recent = this.now() - message.date * 1000 <= BACKLOG_AGE_MS;
    const aboutTask = recent ? this.deps.taskWords?.wants(chatId, repliedTo) ?? null : null;
    if (aboutTask && this.deps.taskWords) {
      await this.flush(chatId);
      await this.deps.taskWords.take(chatId, {
        text, messageId: message.message_id, ...(repliedTo !== undefined ? { replyToMessageId: repliedTo } : {}),
        notTheUsers: !!from || !!message.via_bot, hasPhoto: !!message.photo?.length,
      }, aboutTask);
      return false;
    }

    let image: Image | null = prefetched ?? null;
    if (message.photo?.length && prefetched === undefined) {
      const photo = await fetchPhoto(this.deps.client, message.photo);
      if (photo.ok) image = photo.image;
      else this.reply(chatId, `⚠️ ${escapeTelegramHtml(photo.reason)}`);
    }
    const part = from ? wrapForwarded(from, text) : text;
    if (!part.trim() && !image) {
      if (!message.photo?.length) this.reply(chatId, "I can read text and photos only.");
      return false;
    }
    const quote = this.quoteOf(chatId, message);

    if (this.now() - message.date * 1000 > BACKLOG_AGE_MS) {
      await this.flush(chatId);
      this.askAboutBacklog(chatId, message.date, part, image ? [image] : [], updateId, undefined, quote);
      return false;
    }

    // A burst answers at most one message: a reply to another one sends what was gathered first.
    const held = this.lanes.get(chatId)?.gathered?.quote;
    if (quote && held && held.sourceId !== quote.sourceId) await this.flush(chatId);
    const lane = this.lanes.get(chatId)!;
    const gathered = lane.gathered ??= { updateIds: [], parts: [], images: [], quote: null };
    gathered.updateIds.push(updateId);
    if (part.trim()) gathered.parts.push(part);
    if (image) gathered.images.push(image);
    gathered.quote ??= quote;
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = null;
    // A voice being read holds the burst open: it is sent when the transcript is ready.
    if (gathered.voice) return true;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      this.onLane(chatId, () => this.flush(chatId));
    }, Math.max(0, this.deps.debounceMs()));
    return true;
  }

  /**
   * A reply to a card (one message, or every photo of an album) with its photos fetched. `handled`
   * is true when the card took it or the user was told why not; otherwise the card could not be
   * found after all, and the caller sends the words, with `images`, to the Assistant.
   */
  private async answerCard(
    chatId: string, messages: readonly TelegramMessage[], repliedTo: number, updateId: number,
  ): Promise<{ handled: boolean; text: string; images: Image[]; photosTried: boolean }> {
    const first = messages[0]!;
    const from = forwardedFrom(first) ?? viaInlineBot(first);
    const text = messages.map((m) => m.text ?? m.caption ?? "").filter((t) => t.trim()).join("\n\n");
    const photos = messages.flatMap((m) => (m.photo?.length ? [m.photo] : []));
    const card: CardReplyMessage = {
      text, replyToMessageId: repliedTo, messageId: first.message_id, notTheUsers: !!from || !!first.via_bot,
    };
    if (this.now() - first.date * 1000 > BACKLOG_AGE_MS) {
      // A backlog reply is asked about with its words only: its photos are not held for hours.
      if (photos.length && !text.trim()) {
        this.reply(chatId, BACKLOG_PHOTO_ONLY_NOTE);
        return { handled: true, text, images: [], photosTried: false };
      }
      if (photos.length) this.reply(chatId, BACKLOG_PHOTO_DROPPED_NOTE);
      // Quoted too: when Run comes, the card may no longer take replies and the words go to the Assistant.
      this.askAboutBacklog(chatId, first.date, from ? wrapForwarded(from, text) : text, [], updateId, card, this.quoteOf(chatId, first));
      return { handled: true, text, images: [], photosTried: false };
    }
    let images: Image[] = [];
    let photosTried = false;
    // A forwarded photo is refused along with its words, so it is not downloaded first.
    if (photos.length && !card.notTheUsers) {
      // A card reply's images are held to the card reply's own cap, smaller than the Assistant's.
      const fetched = await fetchPhotos(this.deps.client, photos, MAX_IMAGES, { maxBytes: MAX_REPLY_IMAGE_BYTES, sizeText: REPLY_IMAGE_SIZE_TEXT });
      photosTried = true;
      images = fetched.images;
      for (const reason of fetched.failures) this.reply(chatId, `⚠️ ${escapeTelegramHtml(reason)}`);
      if (fetched.dropped) this.reply(chatId, `Only the first ${MAX_IMAGES} photos were sent.`);
      // Nothing left to send: the user was told why, and an empty reply is never sent.
      if (!text.trim() && !images.length) return { handled: true, text, images, photosTried };
      if (images.length) card.images = images;
    }
    return { handled: await this.deps.replyToCard!(chatId, card), text, images, photosTried };
  }

  /** (Re)starts the wait for an album's next photo; a timer outliving its album does nothing. */
  private armAlbum(chatId: string, album: CardAlbum): void {
    if (album.timer) clearTimeout(album.timer);
    album.timer = setTimeout(() => {
      album.timer = null;
      this.onLane(chatId, async () => {
        if (this.lanes.get(chatId)?.album === album) await this.flushAlbum(chatId);
      });
    }, Math.max(0, this.deps.albumDebounceMs?.() ?? CARD_ALBUM_DEBOUNCE_MS));
  }

  /** Sends a gathered album as one reply to its card. Runs on the chat's lane. */
  private async flushAlbum(chatId: string): Promise<void> {
    const lane = this.lanes.get(chatId);
    const album = lane?.album;
    if (!lane || !album) return;
    lane.album = null;
    if (album.timer) { clearTimeout(album.timer); album.timer = null; }
    try {
      const messages = [...album.messages].sort((a, b) => a.message_id - b.message_id);
      const answered = await this.answerCard(chatId, messages, album.replyTo, album.updateIds[0]!);
      if (!answered.handled) await this.deliver(chatId, answered.text, answered.images, this.quoteOf(chatId, messages[0]!));
    } finally {
      for (const id of album.updateIds) this.deps.delivered(id);
    }
  }

  /** What the message replies to, quoted for the Assistant; null when it replies to nothing. */
  private quoteOf(chatId: string, message: TelegramMessage): TelegramQuote | null {
    const replied = message.reply_to_message;
    if (!replied) return null;
    let source: BotSource = { kind: "notice" };
    try {
      const card = this.deps.cardOf?.(chatId, replied.message_id) ?? null;
      const answer = card ? null : this.deps.answerOf?.(chatId, replied.message_id) ?? null;
      if (card) source = { kind: "card", card };
      else if (answer) source = { kind: "answer", clean: answer.trusted && answer.sessionId === this.deps.boundSessionOf?.(chatId) };
    } catch (e) {
      log.warn(`Telegram chat ${chatId}: what a replied message was is unreadable: ${(e as Error).message}`);
    }
    return quoteTelegramMessage(chatId, replied, source);
  }

  /** Sends what the chat gathered as one message. Runs on the chat's lane. */
  private async flush(chatId: string): Promise<void> {
    const lane = this.lanes.get(chatId);
    const gathered = lane?.gathered;
    if (!lane || !gathered) return;
    lane.gathered = null;
    if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
    // A burst a voice is still being read for is the voice's to send: it only stops gathering, and
    // whatever comes next is a message of its own.
    if (gathered.voice) return;
    await this.deliverBundle(chatId, gathered, null);
  }

  /**
   * Sends a bundle as one message, the voice part (if any) last, and confirms its updates. A voice
   * that answers a card or a task goes there instead (`answerWithVoice`).
   */
  private async deliverBundle(chatId: string, bundle: Gathered, voice: VoicePart | null): Promise<void> {
    try {
      if (bundle.words && voice) return await this.answerWithVoice(chatId, bundle.words, voice, bundle.quote);
      const parts = voice ? [...bundle.parts, encodeVoicePart(voice)] : bundle.parts;
      if (bundle.images.length) this.photoSentAt.set(chatId, this.now());
      if (parts.length || bundle.images.length) await this.deliver(chatId, parts.join("\n\n"), bundle.images, bundle.quote);
    } finally {
      for (const id of bundle.updateIds.splice(0)) this.deps.delivered(id);
    }
  }

  /** The bundle stops gathering: what arrives next starts a new one. */
  private release(chatId: string, bundle: Gathered): void {
    const lane = this.lanes.get(chatId);
    if (!lane || lane.gathered !== bundle) return;
    lane.gathered = null;
    if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
  }

  /**
   * A voice message: refused when too long, too large or sent while PPM was off; otherwise it joins
   * (or starts) the chat's burst and is read off the lane. True: its update is confirmed later.
   */
  private async voiceMessage(chatId: string, message: TelegramMessage, updateId: number): Promise<boolean> {
    const audioExt = message.voice ? undefined : audioFileExt(message.audio!);
    const refusal = this.now() - message.date * 1000 > BACKLOG_AGE_MS ? VOICE_OLD_TEXT
      : message.voice ? voiceRefusal(message.voice)
      : audioExt ? voiceRefusal(message.audio!, "audio file") : AUDIO_FORMAT_TEXT;
    if (refusal) {
      this.reply(chatId, escapeTelegramHtml(refusal));
      return false;
    }
    const quote = this.quoteOf(chatId, message);
    const words = this.voiceWordsAim(chatId, message);
    if (words) {
      // Like typed words to a card, it is never merged into a gathered message: what was gathered
      // goes first, and nothing sent while it is read joins it.
      await this.flush(chatId);
      this.voice!.start(chatId, message, { updateIds: [updateId], parts: [], images: [], quote, words }, audioExt ?? undefined);
      return true;
    }
    const held = this.lanes.get(chatId)?.gathered;
    // One voice per message, and a burst answers at most one message: either sends what was gathered.
    if (held && (held.voice || (quote && held.quote && held.quote.sourceId !== quote.sourceId))) await this.flush(chatId);
    const lane = this.lanes.get(chatId)!;
    const gathered = lane.gathered ??= { updateIds: [], parts: [], images: [], quote: null };
    gathered.updateIds.push(updateId);
    gathered.quote ??= quote;
    if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
    this.voice!.start(chatId, message, gathered, audioExt ?? undefined);
    return true;
  }

  /**
   * Whether a voice message answers a card or a task, decided when it arrives as it is for typed
   * words: a reply to one of the Assistant's cards, to a question card that takes words, or to a
   * task card, or the message after ✏️ Other or "Message about this task". Null: it is for the
   * Assistant, and gathers with what else is sent.
   */
  private voiceWordsAim(chatId: string, message: TelegramMessage): VoiceWordsAim | null {
    const repliedTo = message.reply_to_message?.message_id;
    const aimed = (repliedTo !== undefined && !!this.deps.isCardMessage?.(chatId, repliedTo))
      || !!this.deps.wantsTypedAnswer?.(chatId, repliedTo)
      || !!this.deps.taskWords?.wants(chatId, repliedTo);
    return aimed ? { messageId: message.message_id, ...(repliedTo !== undefined ? { replyToMessageId: repliedTo } : {}) } : null;
  }

  /**
   * A voice message's transcript, read and (if asked) reviewed, sent where typed words to the same
   * message go, in the same order: a question card that takes words, one of the Assistant's cards
   * (its manager chat gets the transcript as a voice message in the user-words block, through
   * `forward-verbatim.ts`), a task's chat; else the Assistant, with the voice part and the quote.
   * Every rule of a typed reply holds: a card decided, withdrawn, replaced or older than a day is
   * refused or asked about exactly as a typed reply to it would be. Runs on the chat's lane.
   */
  private async answerWithVoice(chatId: string, aim: VoiceWordsAim, voice: VoicePart, quote: TelegramQuote | null): Promise<void> {
    const repliedTo = aim.replyToMessageId;
    const text = voice.transcript;
    const spoken = { path: voice.path, durationSec: voice.durationSec };
    const said = this.deps.typedAnswer?.(chatId, {
      text, notTheUsers: false, hasPhoto: false, ...(repliedTo !== undefined ? { replyToMessageId: repliedTo } : {}),
    }) ?? null;
    if (said !== null) {
      // A question's answer is its words: nothing names the audio, so it is not kept.
      try { rmSync(voice.path, { force: true }); } catch { /* best effort */ }
      return this.reply(chatId, said);
    }
    if (repliedTo !== undefined && this.deps.replyToCard && this.deps.isCardMessage?.(chatId, repliedTo)) {
      const card: CardReplyMessage = { text, voice: spoken, replyToMessageId: repliedTo, messageId: aim.messageId, notTheUsers: false };
      if (await this.deps.replyToCard(chatId, card)) return;
    }
    const aboutTask = this.deps.taskWords?.wants(chatId, repliedTo) ?? null;
    if (aboutTask && this.deps.taskWords) {
      return this.deps.taskWords.take(chatId, {
        text, messageId: aim.messageId, notTheUsers: false, hasPhoto: false, voice: spoken,
        ...(repliedTo !== undefined ? { replyToMessageId: repliedTo } : {}),
      }, aboutTask);
    }
    // Nothing takes it any more (the card moved on while it was read): it goes to the Assistant, as
    // typed words would have, quoting what it replied to.
    await this.deliver(chatId, encodeVoicePart(voice), [], quote);
  }

  /** A voice message while the feature is off: said plainly, with a button to turn it on when Whisper is there. */
  private voiceOff(chatId: string, updateId: number): void {
    const ready = this.deps.voice?.whisperReady() ?? false;
    const markup = ready ? { inline_keyboard: [[{
      text: "Turn on voice messages",
      callback_data: this.deps.codes.mint(chatId, `voice_enable:${chatId}:${updateId}`, { kind: "voice_enable" }),
    }]] } : undefined;
    this.reply(chatId, voiceOffHtml(ready), markup);
  }

  private async deliver(chatId: string, text: string, images: Image[], quote: TelegramQuote | null = null): Promise<void> {
    const control = chatControl();
    if (!control) return this.reply(chatId, "⚠️ PPM's chat service is not running.");
    if (images.length > MAX_IMAGES) this.reply(chatId, `Only the first ${MAX_IMAGES} photos were sent.`);
    try {
      const bound = await ensureBoundSession(chatId);
      const result = await control.sendUserMessage(bound.sessionId, text, {
        origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: bound.providerId,
        ...(images.length ? { images: images.slice(0, MAX_IMAGES) } : {}),
        ...(quote ? { replyTo: toReplyReference(quote, bound.sessionId, bound.providerId) } : {}),
      });
      if (!result.ok) this.reply(chatId, `⚠️ Not sent: ${escapeTelegramHtml(result.error)}`);
    } catch (e) {
      const message = e instanceof BindingError ? e.message : "PPM could not start a conversation; see its log.";
      if (!(e instanceof BindingError)) log.warn(`Telegram chat ${chatId}: could not deliver: ${(e as Error).message}`);
      this.reply(chatId, `⚠️ ${escapeTelegramHtml(message)}`);
    }
  }

  private askAboutBacklog(
    chatId: string, date: number, text: string, images: Image[], updateId: number, card?: CardReplyMessage, quote?: TelegramQuote | null,
  ): void {
    while (this.backlog.size >= MAX_PENDING_BACKLOG) this.backlog.delete(this.backlog.keys().next().value!);
    const pendingId = `${chatId}:${updateId}`;
    this.backlog.set(pendingId, { chatId, text, images, ...(card ? { card } : {}), ...(quote ? { quote } : {}) });
    const group = `backlog:${pendingId}`;
    const markup = { inline_keyboard: [[
      { text: "Run", callback_data: this.deps.codes.mint(chatId, group, { kind: "backlog", pendingId, run: true }) },
      { text: "Skip", callback_data: this.deps.codes.mint(chatId, group, { kind: "backlog", pendingId, run: false }) },
    ]] };
    this.reply(chatId, backlogQuestion(date, text), markup);
  }

  private async press(chatId: string, cq: TelegramCallbackQuery): Promise<void> {
    const access = checkAccess(cq.message?.chat, cq.from);
    if (!access.ok) {
      await this.deps.client.answerCallbackQuery(cq.id, "Not allowed.");
      return;
    }
    const found = this.deps.codes.peek(cq.data, chatId);
    if (!found.ok) {
      await this.deps.client.answerCallbackQuery(cq.id, "This button is no longer valid.");
      return;
    }
    const action = found.action;
    if (action.kind === "voice") {
      const toast = this.voice ? await this.voice.press(chatId, action, found.group) : "This button is no longer valid.";
      await this.deps.client.answerCallbackQuery(cq.id, toast);
      return;
    }
    if (action.kind === "card") {
      // Answered first and quickly: the toast says what happened, and the spinner stops.
      await this.deps.client.answerCallbackQuery(cq.id, this.deps.pressCard(chatId, action, found.group, cq));
      return;
    }
    if (action.kind === "task") {
      const toast = this.deps.pressTask ? await this.deps.pressTask(chatId, action, found.group, cq) : "This button is no longer valid.";
      await this.deps.client.answerCallbackQuery(cq.id, toast);
      return;
    }
    if (action.kind === "settings") {
      const toast = this.deps.pressSettings ? await this.deps.pressSettings(chatId, action, found.group) : "This button is no longer valid.";
      await this.deps.client.answerCallbackQuery(cq.id, toast);
      return;
    }
    if (action.kind === "mcard") {
      const toast = this.deps.pressManagerCard ? await this.deps.pressManagerCard(chatId, action, found.group) : "This button is no longer valid.";
      await this.deps.client.answerCallbackQuery(cq.id, toast);
      return;
    }
    this.deps.codes.dropGroup(found.group);
    const messageId = cq.message?.message_id;
    if (messageId) this.removeButtons(chatId, messageId);
    if (action.kind === "voice_enable") {
      let toast = "Voice messages are on. Send the voice message again.";
      try {
        this.deps.voice?.enable();
      } catch (e) {
        log.warn(`Telegram chat ${chatId}: could not turn voice messages on: ${(e as Error).message}`);
        toast = "Could not turn them on; see PPM's log.";
      }
      await this.deps.client.answerCallbackQuery(cq.id, toast);
      return;
    }
    if (action.kind === "switch") {
      await this.deps.client.answerCallbackQuery(cq.id, this.deps.switchSession(chatId, action.sessionId));
      return;
    }
    if (action.kind === "quiet") {
      let on: boolean;
      try {
        on = setQuietWhileInPpm(action.on);
      } catch (e) {
        log.warn(`Telegram chat ${chatId}: could not change the quiet switch: ${(e as Error).message}`);
        await this.deps.client.answerCallbackQuery(cq.id, "Could not change it; see PPM's log.");
        return;
      }
      await this.deps.client.answerCallbackQuery(cq.id, on ? "Quiet while at PPM: on." : "Quiet while at PPM: off.");
      this.reply(chatId, quietStatusHtml(on));
      return;
    }
    const pending = this.backlog.get(action.pendingId);
    this.backlog.delete(action.pendingId);
    await this.deps.client.answerCallbackQuery(cq.id, !pending ? "This button is no longer valid." : action.run ? "Sending it now." : "Skipped.");
    if (!pending || !action.run) return;
    // A reply to a card that waited while PPM was off still answers that card.
    if (pending.card && this.deps.replyToCard && await this.deps.replyToCard(chatId, pending.card)) return;
    await this.deliver(chatId, pending.text, pending.images, pending.quote ?? null);
  }

  private removeButtons(chatId: string, messageId: number): void {
    this.deps.queue.enqueue(chatId, {
      final: true, label: "remove buttons",
      run: async (client) => {
        const res = await client.editMessageReplyMarkup(chatId, messageId, null);
        return res.ok ? { kind: "done" } : { kind: "failed", why: `${res.errorCode} ${res.description}` };
      },
    });
  }
}
