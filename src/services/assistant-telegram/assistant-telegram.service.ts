/**
 * The bridge between Telegram and the PPM Assistant: a Telegram chat is a second window onto
 * one Assistant session. Messages from the phone go into the session; its answers, its approval
 * cards and what is typed in PPM come back out.
 *
 * One reader per bot (Telegram answers a second `getUpdates` with 409), so the bridge tells the
 * connect-link poller it is reading this bot, and passes `/start <token>` to the connect code
 * before any access check — that message is how a chat becomes allowed at all.
 *
 * It also carries what the user asked to hear about other chats (`assistant-telegram-relay.ts`):
 * a watched chat's cards, and watch reports from Assistant sessions no chat is bound to.
 *
 * Nothing here runs on its own: `startAssistantHub()` starts it when the Telegram side of the
 * Assistant is switched on.
 */
import { TelegramBotClient, type TelegramBotClientOptions } from "../telegram/telegram-bot-client.ts";
import { BOT_TOKEN_RE } from "../telegram/telegram-api-base.ts";
import type { TelegramCallbackQuery } from "../telegram/telegram-types.ts";
import { ppmbotReading } from "../telegram-connect.service.ts";
import { getPPMBotBot } from "../telegram-bots.ts";
import { configService } from "../config.service.ts";
import { clearSessionUnread, getSessionTitle } from "../db.service.ts";
import { addNotificationSuppressor } from "../chat-control/notification-suppressor.ts";
import { telegramChatsBoundTo } from "../assistant-hub/assistant-hub-db.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import type { PPMBotConfig } from "../../types/config.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import { assistantSessionTitle, BindingError, bindChat, onBindingChanged, unbindChat } from "./assistant-telegram-binding.ts";
import { BOT_COMMANDS } from "./assistant-telegram-commands.ts";
import { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import type { BridgeAction, CardPress } from "./assistant-telegram-actions.ts";
import { AssistantTelegramInbound } from "./assistant-telegram-inbound.ts";
import { AssistantTelegramCards } from "./assistant-telegram-cards.ts";
import { assistantSessionLink, chatLink } from "./assistant-telegram-links.ts";
import { AssistantTelegramMirror, type MirrorCardSink } from "./assistant-telegram-mirror.ts";
import { AssistantTelegramRelay } from "./assistant-telegram-relay.ts";
import type { RelayedCard } from "./assistant-telegram-cards.ts";
import { AssistantTelegramPoller } from "./assistant-telegram-poller.ts";
import { AssistantTelegramSendQueue, EDIT_INTERVAL_MS, outcomeOf, sendMessageTask } from "./assistant-telegram-send-queue.ts";
import { BridgeStateStore, readBridgeState } from "./assistant-telegram-state.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export const POLL_TIMEOUT_S = 25;
/** A push about a bound session is held back only if the chat got a message this recently. */
export const SUPPRESS_WINDOW_MS = 60_000;
export const RESTARTED_TEXT = "⚠️ PPM restarted — this answer was cut off.";

/** Approval and question cards on Telegram (the cards module). */
export interface BridgeCards extends MirrorCardSink {
  /** Another chat's card (a watched chat's, or one `/status` lists), answered from here. */
  relayed(chatId: string, card: RelayedCard): void;
  /** Whether this chat already shows (or is about to show) that card. */
  isShowing(chatId: string, requestId: string): boolean;
  /** Acts on a pressed card button; the toast to show. */
  press(chatId: string, press: CardPress, group: string, cq: TelegramCallbackQuery): string;
  forgetChat(chatId: string): void;
}

export interface BridgeDeps {
  queue: AssistantTelegramSendQueue;
  state: BridgeStateStore;
  codes: ButtonCodes<BridgeAction>;
  now: () => number;
  /** The link that opens an Assistant session in PPM. */
  sessionLink: (providerId: string, sessionId: string) => Promise<string>;
  /** The link that opens any chat of a project in PPM. */
  chatLink: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
}

export interface BridgeStartOptions {
  /** Defaults to the Assistant's bot (`ppmbot_telegram`). */
  token?: string;
  client?: TelegramBotClientOptions;
  /** Tests shrink retry waits. */
  scaleDelay?: (ms: number) => number;
  /** Defaults to `clawbot.debounce_ms`. */
  debounceMs?: number;
  pollTimeoutS?: number;
  now?: () => number;
  /** Builds the card handler; tests replace it. */
  cards?: (deps: BridgeDeps) => BridgeCards;
  /** Defaults to the tunnel / Tailscale / localhost link notifications use; tests pin it. */
  sessionLink?: (providerId: string, sessionId: string) => Promise<string>;
  /** The same, for a chat of any project (a watched chat's card, `/status`). */
  chatLink?: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
}

function bridgeConfig(): Pick<PPMBotConfig, "enabled" | "show_tool_calls" | "debounce_ms"> {
  const c = configService.get("clawbot") as Partial<PPMBotConfig> | undefined;
  return { enabled: c?.enabled === true, show_tool_calls: c?.show_tool_calls !== false, debounce_ms: typeof c?.debounce_ms === "number" ? c.debounce_ms : 2000 };
}

/** Everything one running bridge holds; gone when it stops. */
interface Running {
  poller: AssistantTelegramPoller;
  queue: AssistantTelegramSendQueue;
  state: BridgeStateStore;
  inbound: AssistantTelegramInbound;
  mirror: AssistantTelegramMirror;
  relay: AssistantTelegramRelay;
  cards: BridgeCards;
  codes: ButtonCodes<BridgeAction>;
  offs: Array<() => void>;
}

export class AssistantTelegramBridge {
  private run: Running | null = null;

  get running(): boolean {
    return this.run !== null;
  }

  /** Why the bot could not be read, for Settings. */
  get lastError(): string | null {
    return this.run?.poller.lastError ?? null;
  }

  async start(opts: BridgeStartOptions = {}): Promise<void> {
    if (this.run) return;
    const token = opts.token ?? getPPMBotBot().bot_token;
    if (!BOT_TOKEN_RE.test(token)) throw new Error("PPM Assistant has no Telegram bot token");
    const now = opts.now ?? Date.now;
    const client = new TelegramBotClient(token, { editIntervalMs: EDIT_INTERVAL_MS, ...opts.client });
    const queue = new AssistantTelegramSendQueue(client, { canSend: canSendTo, now, ...(opts.scaleDelay ? { scaleDelay: opts.scaleDelay } : {}) });
    const state = new BridgeStateStore(readBridgeState(client.botId));
    const codes = new ButtonCodes<BridgeAction>({ now });
    const links = { sessionLink: opts.sessionLink ?? assistantSessionLink, chatLink: opts.chatLink ?? chatLink };
    const cards = (opts.cards ?? ((deps) => new AssistantTelegramCards(deps)))({ queue, state, codes, now, ...links });
    const relay = new AssistantTelegramRelay({
      queue, chatLink: links.chatLink, relayCard: (chatId, card) => cards.relayed(chatId, card),
    });
    const mirror = new AssistantTelegramMirror({
      queue, state, now, cards,
      showToolCalls: () => bridgeConfig().show_tool_calls,
      onTurnDelivered: (sessionId) => markRead(sessionId),
    });
    let poller: AssistantTelegramPoller | null = null;
    const inbound = new AssistantTelegramInbound({
      client, token, queue, codes, now,
      debounceMs: () => opts.debounceMs ?? bridgeConfig().debounce_ms,
      delivered: (id) => poller?.delivered(id),
      pressCard: (chatId, press, group, cq) => cards.press(chatId, press, group, cq),
      switchSession: (chatId, sessionId) => this.switchSession(chatId, sessionId),
      relayCard: (chatId, card) => cards.relayed(chatId, card),
    });
    poller = new AssistantTelegramPoller(client, state, (update) => inbound.dispatch(update));
    const offs = [
      onBindingChanged(() => mirror.invalidate()),
      addNotificationSuppressor((sessionId) => recentlyTold(queue, sessionId)),
    ];
    this.run = { poller, queue, state, inbound, mirror, relay, cards, codes, offs };

    recoverInterrupted(queue, state);
    mirror.attach();
    relay.attach();
    ppmbotReading(token);
    void client.setMyCommands(BOT_COMMANDS);
    log.info(`Reading Telegram bot ${client.botId}`);
    poller.start(opts.pollTimeoutS ?? POLL_TIMEOUT_S);
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = null;
    for (const off of run.offs) off();
    run.relay.detach();
    run.mirror.detach();
    run.inbound.stop();
    await run.poller.stop();
    run.queue.stop();
    ppmbotReading(null);
    log.info("Stopped reading Telegram");
  }

  /** The chat was disconnected: unbound, and nothing more is sent to it — not even what was queued. */
  forgetChat(chatId: string): void {
    unbindChat(chatId);
    const run = this.run;
    if (!run) return;
    run.queue.forget(chatId, "chat disconnected");
    run.mirror.forgetChat(chatId);
    run.cards.forgetChat(chatId);
    run.codes.dropChat(chatId);
    run.inbound.forgetChat(chatId);
    run.state.forgetChat(chatId);
  }

  /** Test hook: resolves once what has arrived was handled and what was queued was sent. */
  async settle(): Promise<void> {
    await this.run?.inbound.settle();
    await this.run?.queue.whenIdle();
  }

  private switchSession(chatId: string, sessionId: string): string {
    const queue = this.run?.queue;
    try {
      const binding = bindChat(chatId, sessionId);
      // The name `/sessions` showed: the user's rename, else the provider's title (its first message).
      void assistantSessionTitle(binding.sessionId, binding.providerId).catch(() => null).then((found) => {
        const title = redactForTelegram(found || getSessionTitle(sessionId) || "that conversation");
        queue?.enqueue(chatId, sendMessageTask(queue, chatId, { html: `Now talking to <b>${escapeTelegramHtml(title)}</b>.` }, { label: "switched" }));
      });
      return "Switched.";
    } catch (e) {
      return e instanceof BindingError ? e.message : "Could not switch.";
    }
  }
}

/** A push for a bound session says nothing the phone was not just told. */
function recentlyTold(queue: AssistantTelegramSendQueue, sessionId: string): boolean {
  const now = Date.now();
  return telegramChatsBoundTo(sessionId).some((chatId) =>
    canSendTo(chatId) && now - (queue.lastSentAt(chatId) ?? -Infinity) < SUPPRESS_WINDOW_MS);
}

/** The answer is on the phone: the session is read. */
function markRead(sessionId: string): void {
  try {
    clearSessionUnread(sessionId);
    broadcastGlobalEvent({ type: "session:unread_changed", sessionId, unreadCount: 0, unreadType: null, projectName: ASSISTANT_PROJECT_NAME });
  } catch (e) {
    log.warn(`Could not mark session ${sessionId} read: ${(e as Error).message}`);
  }
}

/** Answers PPM was writing and cards it was showing when it stopped: nothing will finish them. */
function recoverInterrupted(queue: AssistantTelegramSendQueue, state: BridgeStateStore): void {
  for (const [chatId, msgs] of Object.entries(state.takeAll())) {
    for (const id of msgs.render) {
      let attempts = 0;
      queue.enqueue(chatId, {
        final: true, label: "restart note",
        run: async (c) => outcomeOf(await c.editMessageText(chatId, id, RESTARTED_TEXT, { final: true }), ++attempts),
      });
    }
    for (const id of msgs.cards) {
      let attempts = 0;
      queue.enqueue(chatId, {
        final: true, label: "expired card",
        run: async (c) => outcomeOf(await c.editMessageReplyMarkup(chatId, id, null), ++attempts),
      });
    }
  }
}

/** The one bridge this server runs. */
export const assistantTelegramBridge = new AssistantTelegramBridge();

export { bridgeConfig as assistantTelegramConfig };
