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
import { parseCommand, runCommand } from "./assistant-telegram-commands.ts";
import { fetchPhoto } from "./assistant-telegram-photos.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import type { BridgeAction } from "./assistant-telegram-actions.ts";
import { forwardedFrom, wrapForwarded, backlogQuestion } from "./assistant-telegram-inbound-text.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** A message older than this was sent while PPM was off: asked about rather than run. */
export const BACKLOG_AGE_MS = 10 * 60_000;
const MAX_IMAGES = 5;
const MAX_PENDING_BACKLOG = 50;

type Image = { data: string; mediaType: string };
interface Gathered { updateIds: number[]; parts: string[]; images: Image[] }

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
  now?: () => number;
}

interface ChatLane { chain: Promise<void>; gathered: Gathered | null; timer: ReturnType<typeof setTimeout> | null }

export class AssistantTelegramInbound {
  private readonly lanes = new Map<string, ChatLane>();
  private readonly refused = new Set<string>();
  private readonly backlog = new Map<string, { chatId: string; text: string; images: Image[] }>();
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly deps: InboundDeps) {
    this.now = deps.now ?? Date.now;
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
      if ([...this.lanes.values()].every((l) => !l.gathered && !l.timer)) return;
      await Bun.sleep(10);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const chatId of [...this.lanes.keys()]) this.forgetChat(chatId);
  }

  /** Drops what a chat had gathered; its updates are confirmed so they are not read again. */
  forgetChat(chatId: string): void {
    const lane = this.lanes.get(chatId);
    if (lane?.timer) clearTimeout(lane.timer);
    for (const id of lane?.gathered?.updateIds ?? []) this.deps.delivered(id);
    if (lane) { lane.gathered = null; lane.timer = null; }
    for (const [id, b] of this.backlog) if (b.chatId === chatId) this.backlog.delete(id);
    this.forgetRefusals(chatId);
  }

  private forgetRefusals(chatId: string): void {
    for (const key of [...this.refused]) if (key.startsWith(`${chatId}:`)) this.refused.delete(key);
  }

  private onLane(chatId: string, work: () => Promise<void>): void {
    let lane = this.lanes.get(chatId);
    if (!lane) this.lanes.set(chatId, lane = { chain: Promise.resolve(), gathered: null, timer: null });
    lane.chain = lane.chain.then(work).catch((e) => log.warn(`Telegram chat ${chatId}: ${(e as Error)?.message ?? e}`));
  }

  private reply(chatId: string, html: string, markup?: InlineKeyboardMarkup): void {
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html, ...(markup ? { markup } : {}) }, { label: "reply" }));
  }

  private async handle(chatId: string, update: TelegramUpdate): Promise<void> {
    try {
      if (update.callback_query) {
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

    const from = forwardedFrom(message);
    // A forwarded "/stop" is someone else's text, not the owner's command.
    const command = from ? null : parseCommand(message.text);
    if (command) {
      await this.flush(chatId);
      await runCommand(command, {
        chatId,
        reply: (html, markup) => this.reply(chatId, html, markup),
        switchCode: (sessionId) => this.deps.codes.mint(chatId, `switch:${chatId}:${updateId}`, { kind: "switch", sessionId }),
      });
      return false;
    }

    let image: Image | null = null;
    if (message.photo?.length) {
      const photo = await fetchPhoto(this.deps.client, message.photo);
      if (photo.ok) image = photo.image;
      else this.reply(chatId, `⚠️ ${escapeTelegramHtml(photo.reason)}`);
    }
    const part = from ? wrapForwarded(from, text) : text;
    if (!part.trim() && !image) {
      if (!message.photo?.length) this.reply(chatId, "I can read text and photos only.");
      return false;
    }

    if (this.now() - message.date * 1000 > BACKLOG_AGE_MS) {
      await this.flush(chatId);
      this.askAboutBacklog(chatId, message.date, part, image ? [image] : [], updateId);
      return false;
    }

    const lane = this.lanes.get(chatId)!;
    const gathered = lane.gathered ??= { updateIds: [], parts: [], images: [] };
    gathered.updateIds.push(updateId);
    if (part.trim()) gathered.parts.push(part);
    if (image) gathered.images.push(image);
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = setTimeout(() => {
      lane.timer = null;
      this.onLane(chatId, () => this.flush(chatId));
    }, Math.max(0, this.deps.debounceMs()));
    return true;
  }

  /** Sends what the chat gathered as one message. Runs on the chat's lane. */
  private async flush(chatId: string): Promise<void> {
    const lane = this.lanes.get(chatId);
    const gathered = lane?.gathered;
    if (!lane || !gathered) return;
    lane.gathered = null;
    if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
    try {
      await this.deliver(chatId, gathered.parts.join("\n\n"), gathered.images);
    } finally {
      for (const id of gathered.updateIds) this.deps.delivered(id);
    }
  }

  private async deliver(chatId: string, text: string, images: Image[]): Promise<void> {
    const control = chatControl();
    if (!control) return this.reply(chatId, "⚠️ PPM's chat service is not running.");
    if (images.length > MAX_IMAGES) this.reply(chatId, `Only the first ${MAX_IMAGES} photos were sent.`);
    try {
      const bound = await ensureBoundSession(chatId);
      const result = await control.sendUserMessage(bound.sessionId, text, {
        origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: bound.providerId,
        ...(images.length ? { images: images.slice(0, MAX_IMAGES) } : {}),
      });
      if (!result.ok) this.reply(chatId, `⚠️ Not sent: ${escapeTelegramHtml(result.error)}`);
    } catch (e) {
      const message = e instanceof BindingError ? e.message : "PPM could not start a conversation; see its log.";
      if (!(e instanceof BindingError)) log.warn(`Telegram chat ${chatId}: could not deliver: ${(e as Error).message}`);
      this.reply(chatId, `⚠️ ${escapeTelegramHtml(message)}`);
    }
  }

  private askAboutBacklog(chatId: string, date: number, text: string, images: Image[], updateId: number): void {
    while (this.backlog.size >= MAX_PENDING_BACKLOG) this.backlog.delete(this.backlog.keys().next().value!);
    const pendingId = `${chatId}:${updateId}`;
    this.backlog.set(pendingId, { chatId, text, images });
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
    if (action.kind === "card") {
      // Answered first and quickly: the toast says what happened, and the spinner stops.
      await this.deps.client.answerCallbackQuery(cq.id, this.deps.pressCard(chatId, action, found.group, cq));
      return;
    }
    this.deps.codes.dropGroup(found.group);
    const messageId = cq.message?.message_id;
    if (messageId) this.removeButtons(chatId, messageId);
    if (action.kind === "switch") {
      await this.deps.client.answerCallbackQuery(cq.id, this.deps.switchSession(chatId, action.sessionId));
      return;
    }
    const pending = this.backlog.get(action.pendingId);
    this.backlog.delete(action.pendingId);
    await this.deps.client.answerCallbackQuery(cq.id, !pending ? "This button is no longer valid." : action.run ? "Sending it now." : "Skipped.");
    if (pending && action.run) await this.deliver(chatId, pending.text, pending.images);
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
