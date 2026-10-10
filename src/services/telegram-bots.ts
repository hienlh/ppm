/**
 * Which Telegram bot each part of PPM talks through, and which chats each may reach.
 *
 * Notifications and PPMBot used to share one bot and one list of chats
 * (`clawbot_paired_chats`), so connecting a chat for alerts also let it command PPMBot —
 * an AI that runs commands on this machine. They are kept apart now:
 *
 * - Notifications send through the `telegram` config bot to the chats in the
 *   `telegram_notify_chats` row. Being on that list grants nothing else.
 * - PPM Assistant's Telegram bridge answers through the bot in the `ppmbot_telegram` row, to
 *   the chats approved in `clawbot_paired_chats` — each one connected with a link from
 *   Settings → PPM Assistant → Telegram. Row, table and the `*PPMBotBot` names are PPMBot's,
 *   kept because the Assistant took over PPMBot's bot and chats as they were.
 *
 * Both rows sit outside `CONFIG_TABLE_KEYS`, like the VAPID key: never loaded into the
 * config object, so nothing that dumps config can show the Assistant's token.
 *
 * The two can still name one bot: an install that ran PPMBot before the split keeps the
 * bot it was answering on. Telegram lets one program read a bot, which is why
 * `telegram-connect.service.ts` compares bots by id before it polls one.
 */
import { configService } from "./config.service.ts";
import { getApprovedPairedChats, getConfigValue, setConfigValue } from "./db.service.ts";
import type { PPMBotConfig, TelegramConfig } from "../types/config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("telegram");

const PPMBOT_BOT_ROW = "ppmbot_telegram";
const NOTIFY_CHATS_ROW = "telegram_notify_chats";

/** A chat that receives notifications. */
export interface NotifyChat {
  chatId: string;
  userId: string;
  name: string;
  /** Unix ms. */
  connectedAt: number;
}

/** The digits before the colon. A token reissued by @BotFather keeps them; another bot's does not. */
export function botIdOf(token: string): string | null {
  return /^(\d+):/.exec(token)?.[1] ?? null;
}

export function sameBot(a: string, b: string): boolean {
  const id = botIdOf(a);
  return id !== null && id === botIdOf(b);
}

/**
 * Moves an install off the shared setup, once. Every chat that got alerts keeps getting
 * them. PPMBot keeps the shared bot only if it was switched on: one that was off starts
 * with no bot, so a chat connected for alerts can never reach it. PPMBot's own approvals
 * are left as they are, and its settings show them.
 */
function ensureSplit(): void {
  if (getConfigValue(NOTIFY_CHATS_ROW) === null) {
    const chats: NotifyChat[] = getApprovedPairedChats().map((chat) => ({
      chatId: chat.telegram_chat_id,
      userId: chat.telegram_user_id ?? "",
      name: chat.display_name || `Chat ${chat.telegram_chat_id}`,
      connectedAt: (chat.approved_at ?? chat.created_at) * 1000,
    }));
    setConfigValue(NOTIFY_CHATS_ROW, JSON.stringify(chats));
    if (chats.length > 0) log.info(`Notifications keep their ${chats.length} Telegram chat(s), now apart from PPMBot's`);
  }
  if (getConfigValue(PPMBOT_BOT_ROW) === null) {
    const shared = configService.get("telegram") as TelegramConfig | undefined;
    const inUse = (configService.get("clawbot") as PPMBotConfig | undefined)?.enabled === true && !!shared?.bot_token;
    const bot: TelegramConfig = inUse
      ? { bot_token: shared!.bot_token, ...(shared!.bot_username ? { bot_username: shared!.bot_username } : {}) }
      : { bot_token: "" };
    setConfigValue(PPMBOT_BOT_ROW, JSON.stringify(bot));
    if (inUse) log.info("PPMBot keeps the bot it shared with notifications until it is given one of its own");
  }
}

function readRow(row: string): unknown {
  const raw = getConfigValue(row);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** PPM Assistant's bot (PPMBot's, before). An empty token means it has none yet. */
export function getPPMBotBot(): TelegramConfig {
  ensureSplit();
  const value = readRow(PPMBOT_BOT_ROW) as Partial<TelegramConfig> | undefined;
  if (!value || typeof value.bot_token !== "string") return { bot_token: "" };
  return typeof value.bot_username === "string"
    ? { bot_token: value.bot_token, bot_username: value.bot_username }
    : { bot_token: value.bot_token };
}

export function setPPMBotBot(bot: TelegramConfig): void {
  ensureSplit();
  const before = getConfigValue(PPMBOT_BOT_ROW);
  const json = JSON.stringify(bot);
  setConfigValue(PPMBOT_BOT_ROW, json);
  // The name only: the token is a password for the bot.
  if (before !== json) log.info(bot.bot_token ? `PPM Assistant now uses @${bot.bot_username ?? "?"}` : "PPM Assistant's bot removed");
}

function isNotifyChat(value: unknown): value is NotifyChat {
  const v = value as Partial<NotifyChat> | null;
  return !!v && typeof v.chatId === "string" && typeof v.name === "string";
}

/** Newest first. */
export function listNotifyChats(): NotifyChat[] {
  ensureSplit();
  const value = readRow(NOTIFY_CHATS_ROW);
  return Array.isArray(value) ? value.filter(isNotifyChat) : [];
}

/** Add a chat, or move one already there to the top under its current name. */
export function addNotifyChat(chat: Omit<NotifyChat, "connectedAt">): void {
  const others = listNotifyChats().filter((c) => c.chatId !== chat.chatId);
  setConfigValue(NOTIFY_CHATS_ROW, JSON.stringify([{ ...chat, connectedAt: Date.now() }, ...others]));
}

/** False when the chat was not on the list. */
export function removeNotifyChat(chatId: string): boolean {
  const chats = listNotifyChats();
  const rest = chats.filter((c) => c.chatId !== chatId);
  if (rest.length === chats.length) return false;
  setConfigValue(NOTIFY_CHATS_ROW, JSON.stringify(rest));
  return true;
}
