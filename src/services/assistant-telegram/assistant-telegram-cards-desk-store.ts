/**
 * Which message is each Telegram chat's pinned card desk, kept across restarts in the
 * `assistant_telegram_card_desk` config row (one JSON value, so no migration), and whether the
 * desk is switched on (`clawbot.card_desk`, off until the user answers the feature's question).
 *
 * Message ids count per bot: a row another bot left (the token was changed) names messages this
 * bot cannot edit, and is set aside.
 */
import { configService } from "../config.service.ts";
import { getConfigValue, setConfigValue } from "../db.service.ts";
import type { PPMBotConfig } from "../../types/config.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export const CARD_DESK_ROW = "assistant_telegram_card_desk";

/** Whether the pinned card desk is on: only once the user said so. */
export function cardDeskEnabled(): boolean {
  try {
    return (configService.get("clawbot") as Partial<PPMBotConfig> | undefined)?.card_desk === true;
  } catch {
    return false;
  }
}

export interface CardDeskStore {
  get(chatId: string): number | null;
  set(chatId: string, messageId: number | null): void;
  chats(): string[];
}

interface Stored { botId?: string; chats: Record<string, number> }

/** The row as stored for `botId`; empty when missing, unreadable or another bot's. */
function readRow(botId: string): Stored {
  const state: Stored = { botId, chats: {} };
  try {
    const raw = getConfigValue(CARD_DESK_ROW);
    const parsed = raw ? JSON.parse(raw) as Partial<Stored> : null;
    if (parsed && (parsed.botId === undefined || parsed.botId === botId)) {
      for (const [chatId, id] of Object.entries(parsed.chats ?? {})) {
        if (/^-?\d+$/.test(chatId) && Number.isSafeInteger(id) && (id as number) > 0) state.chats[chatId] = id as number;
      }
    }
  } catch {
    log.warn(`${CARD_DESK_ROW} is not valid JSON; starting without a pinned card list`);
  }
  return state;
}

/**
 * The row for `botId`, read on every call and changed one chat at a time: a bridge stopping while
 * a new one starts (a restart, a new token) must not write back its whole older copy over the new
 * one's ids.
 */
export function configCardDeskStore(botId: string): CardDeskStore {
  return {
    get: (chatId) => readRow(botId).chats[chatId] ?? null,
    set: (chatId, messageId) => {
      const state = readRow(botId);
      if ((state.chats[chatId] ?? null) === messageId) return;
      if (messageId === null) delete state.chats[chatId];
      else state.chats[chatId] = messageId;
      try { setConfigValue(CARD_DESK_ROW, JSON.stringify(state)); } catch (e) {
        // Losing this costs a second pinned list after a restart, never a card.
        log.warn(`Could not save ${CARD_DESK_ROW}: ${(e as Error).message}`);
      }
    },
    chats: () => Object.keys(readRow(botId).chats),
  };
}

/** In memory only (tests). */
export function memoryCardDeskStore(initial: Record<string, number> = {}): CardDeskStore {
  const chats = new Map(Object.entries(initial));
  return {
    get: (chatId) => chats.get(chatId) ?? null,
    set: (chatId, messageId) => { if (messageId === null) chats.delete(chatId); else chats.set(chatId, messageId); },
    chats: () => [...chats.keys()],
  };
}
