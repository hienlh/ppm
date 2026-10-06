/**
 * One-tap Telegram connect: PPM shows `t.me/<bot>?start=<token>`, the user taps it,
 * Telegram opens the bot and sends `/start <token>`, and that chat is connected.
 *
 * There is one link per bot owner (see `telegram-bots.ts`): Notifications' adds the chat
 * to the alert list and grants nothing else; PPMBot's lets the chat command PPMBot. The
 * token is the proof of ownership a pairing code used to be: it is minted only for a
 * signed-in PPM user, is 128 random bits, works once, and expires in ten minutes.
 *
 * Someone has to read the bot's messages for the `/start` to arrive. PPMBot, while it
 * runs, reads its own bot and passes every message to `handleConnectMessage` first. Any
 * other bot with a link open is polled here, one poller per bot. Telegram allows one
 * reader per bot, so a bot PPMBot is reading — Notifications' too, on an install that
 * still shares one — is left to PPMBot (`ppmbotReading`).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { configService } from "./config.service.ts";
import { upsertApprovedPairing } from "./db.service.ts";
import { escapeTelegramHtml } from "./notification-format.ts";
import { BOT_TOKEN_RE, getBotIdentity, getTelegramUpdates, sendTelegramMessage } from "./telegram-bot-api.ts";
import { addNotifyChat, botIdOf, getPPMBotBot, setPPMBotBot } from "./telegram-bots.ts";
import type { TelegramConfig } from "../types/config.ts";
import type { TelegramMessage } from "../types/ppmbot.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("telegram");

export const CONNECT_TTL_MS = 10 * 60_000;
const START_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;
const POLL_TIMEOUT_S = 25;

export class TelegramConnectError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
  }
}

type Reply = (chatId: string, html: string) => Promise<unknown>;

export interface ConnectStatus {
  active: boolean;
  expiresAt: number | null;
  error: string | null;
}

interface ConnectTarget {
  /** Where in PPM a link is made — named in the reply to a spent one. */
  where: string;
  bot(): TelegramConfig;
  saveBot(bot: TelegramConfig): void;
  connect(chatId: string, userId: string, name: string): void;
  /** The reply in the chat once it is connected. `device` is already escaped. */
  connectedText(device: string): string;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const links: TelegramConnect[] = [];
/** The bot PPMBot is reading, while it runs. */
let ppmbotBotId: string | null = null;

export class TelegramConnect {
  private pending: { token: string; expiresAt: number } | null = null;
  /** Why this link's bot could not be read, from the poller. */
  lastError: string | null = null;

  constructor(private readonly target: ConnectTarget) {
    links.push(this);
  }

  get where(): string {
    return this.target.where;
  }

  botToken(): string {
    return this.target.bot().bot_token;
  }

  isOpen(): boolean {
    return !!this.pending && Date.now() < this.pending.expiresAt;
  }

  status(): ConnectStatus {
    const active = this.isOpen();
    return { active, expiresAt: active ? this.pending!.expiresAt : null, error: this.lastError };
  }

  /**
   * The bot's @username, asked of Telegram once and then kept with its token. Tokens
   * saved before PPM stored the name have none until something needs it.
   */
  async botUsername(): Promise<string> {
    const bot = this.target.bot();
    if (!bot.bot_token) throw new TelegramConnectError("Save a bot token first", 400);
    if (bot.bot_username) return bot.bot_username;
    const identity = await getBotIdentity(bot.bot_token);
    // Another token saved (or the bot removed) while Telegram answered: saving `bot` would put
    // the old token back over it, so the question is asked again about the current one.
    if (this.target.bot().bot_token !== bot.bot_token) return this.botUsername();
    if (!identity.ok) throw new TelegramConnectError(identity.message, identity.reason === "invalid" ? 400 : 502);
    this.target.saveBot({ ...bot, bot_username: identity.username });
    return identity.username;
  }

  /** Mint a link, replacing any earlier one, and make sure the bot's messages are being read. */
  async start(): Promise<{ url: string; expiresAt: number }> {
    const username = await this.botUsername();
    this.pending = { token: randomBytes(16).toString("base64url"), expiresAt: Date.now() + CONNECT_TTL_MS };
    this.lastError = null;
    syncPollers();
    return { url: `https://t.me/${username}?start=${this.pending.token}`, expiresAt: this.pending.expiresAt };
  }

  cancel(): void {
    this.pending = null;
    syncPollers();
  }

  /** Connect the chat that sent `token` if it is this link's. False leaves it to another link. */
  async tryConnect(message: TelegramMessage, token: string, reply: Reply): Promise<boolean> {
    const pending = this.pending;
    if (!pending || Date.now() >= pending.expiresAt || !sameToken(token, pending.token)) return false;
    this.pending = null;
    const chatId = String(message.chat.id);
    const name = message.from?.username ? `${message.from.first_name} (@${message.from.username})` : message.from?.first_name ?? "Telegram";
    this.target.connect(chatId, String(message.from?.id ?? ""), name);
    log.info(`Chat connected in ${this.target.where}: chat ${chatId} user ${message.from?.id ?? "?"}`);
    const device = (configService.get("device_name") as string) || "PPM";
    await reply(chatId, this.target.connectedText(escapeTelegramHtml(device))).catch(() => {});
    // A poller on this bot stops by itself once no link is left open, and confirms what it read.
    return true;
  }
}

/** Alerts only: a chat connected here can read notifications and do nothing else. */
export const notifyConnect = new TelegramConnect({
  where: "Settings → Notifications",
  bot: () => (configService.get("telegram") as TelegramConfig | undefined) ?? { bot_token: "" },
  saveBot: (bot) => configService.set("telegram", bot),
  connect: (chatId, userId, name) => addNotifyChat({ chatId, userId, name }),
  connectedText: (device) => `✅ Connected to <b>${device}</b>. PPM notifications will arrive in this chat.`,
});

/** The one link that lets a chat command PPMBot, which runs AI with access to this machine. */
export const ppmbotConnect = new TelegramConnect({
  where: "Settings → PPMBot",
  bot: getPPMBotBot,
  saveBot: setPPMBotBot,
  connect: upsertApprovedPairing,
  connectedText: (device) => ppmbotBotId
    ? `✅ Connected to <b>${device}</b>. You can chat with PPMBot here — send /start to begin.`
    : `✅ Connected to <b>${device}</b>. PPMBot will answer here once it is turned on in PPM.`,
});

/**
 * Handle `message`, read from the bot `botToken`, if it is a connect attempt. True means
 * it was one — answered, whatever the outcome — so the caller must not treat it as
 * anything else.
 */
export async function handleConnectMessage(message: TelegramMessage, botToken: string, reply: Reply): Promise<boolean> {
  const match = START_RE.exec(message.text ?? "");
  if (!match || !message.chat?.id) return false;
  const botId = botIdOf(botToken);
  // Both links when the two still share a bot.
  const onThisBot = links.filter((link) => botIdOf(link.botToken()) === botId);
  for (const link of onThisBot) {
    if (await link.tryConnect(message, match[1]!, reply)) return true;
  }
  const chatId = String(message.chat.id);
  log.warn(`Connect rejected for chat ${chatId}: link expired or invalid`);
  const where = onThisBot.length === 1 ? onThisBot[0]!.where : "Settings";
  await reply(
    chatId,
    `This link has expired or was already used. In PPM, open <b>${where}</b> and tap <b>Connect Telegram</b> again.`,
  ).catch(() => {});
  return true;
}

/**
 * PPMBot is about to read `token`'s bot (null: it stopped). Telegram answers 409 to one
 * of two readers, so a poller here on that bot must stop first — and once PPMBot stops,
 * a link still open on its bot has to be read here again.
 */
export function ppmbotReading(token: string | null): void {
  ppmbotBotId = token ? botIdOf(token) : null;
  syncPollers();
}

interface Poller {
  token: string;
  controller: AbortController;
}

const pollers = new Map<string, Poller>();

/** Poll each bot that has a link open and is not PPMBot's to read; stop every other poller. */
function syncPollers(): void {
  const wanted = new Map<string, string>();
  for (const link of links) {
    if (!link.isOpen()) continue;
    const token = link.botToken();
    const id = botIdOf(token);
    if (id && id !== ppmbotBotId && BOT_TOKEN_RE.test(token)) wanted.set(id, token);
  }
  for (const [id, poller] of pollers) {
    if (wanted.get(id) === poller.token) continue;
    poller.controller.abort();
    pollers.delete(id);
  }
  for (const [id, token] of wanted) {
    if (pollers.has(id)) continue;
    const poller: Poller = { token, controller: new AbortController() };
    pollers.set(id, poller);
    void runPoller(id, poller);
  }
}

async function runPoller(botId: string, poller: Poller): Promise<void> {
  const { token, controller } = poller;
  const onThisBot = () => links.filter((link) => botIdOf(link.botToken()) === botId);
  const reply: Reply = (chatId, html) => sendTelegramMessage(token, chatId, html);
  let offset = 0;
  try {
    while (!controller.signal.aborted && onThisBot().some((link) => link.isOpen())) {
      const json = await getTelegramUpdates(token, offset, POLL_TIMEOUT_S, controller.signal);
      if (!json.ok) {
        // 409 is a webhook on this bot, or another program reading it.
        const error = json.description ?? "Telegram refused to deliver the bot's messages";
        for (const link of onThisBot()) link.lastError = error;
        log.warn(`Connect poller stopped: ${json.error_code ?? "?"} ${error}`);
        break;
      }
      for (const update of json.result ?? []) {
        offset = update.update_id + 1;
        if (update.message) await handleConnectMessage(update.message, token, reply);
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      // The message only: the request URL carries the bot token.
      const error = `Could not reach Telegram: ${(e as Error).message}`;
      for (const link of onThisBot()) link.lastError = error;
      log.warn(`Connect poller stopped: ${error}`);
    }
  } finally {
    // Confirm the last batch, or the next reader gets the same /start again and answers it
    // as an expired link. Not when stopped from outside: PPMBot took the bot over and reads
    // it now, or a link was cancelled and a new poller may already be reading.
    if (offset > 0 && !controller.signal.aborted) await getTelegramUpdates(token, offset, 0).catch(() => {});
    if (pollers.get(botId) === poller) {
      pollers.delete(botId);
      // A link opened while this poller was confirming found it still registered and started
      // no other, so nothing would read it. A link showing this poller's error is not retried
      // here: a bot that cannot be read would be polled again at once, forever.
      if (onThisBot().some((link) => link.isOpen() && !link.lastError)) syncPollers();
    }
  }
}
