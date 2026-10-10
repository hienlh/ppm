/**
 * What the Telegram bridge must remember across a restart, in the `assistant_telegram_state`
 * config row (one JSON value, so no migration):
 *
 * - `offset`: the first update not yet handed on. Telegram forgets an update once a poll asks
 *   past it, so the bridge never asks past one still waiting in its debounce.
 * - per chat, the messages it was still writing (`render`) and the cards whose buttons were
 *   live (`cards`). After a restart nothing will finish them: the answers are marked as cut off
 *   and the buttons taken away, rather than left looking alive.
 */
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export const BRIDGE_STATE_ROW = "assistant_telegram_state";

/** Bounds a corrupt or runaway row: no chat has this many messages in flight. */
const MAX_IDS_PER_CHAT = 200;

export interface ChatMessages {
  render: number[];
  cards: number[];
}

export interface BridgeState {
  offset: number;
  chats: Record<string, ChatMessages>;
}

const ids = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((n): n is number => Number.isSafeInteger(n) && n > 0).slice(-MAX_IDS_PER_CHAT) : [];

/** The stored state, or an empty one when the row is missing or not what this file writes. */
export function readBridgeState(): BridgeState {
  const raw = getConfigValue(BRIDGE_STATE_ROW);
  if (!raw) return { offset: 0, chats: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<BridgeState>;
    const chats: Record<string, ChatMessages> = {};
    for (const [chatId, value] of Object.entries(parsed.chats ?? {})) {
      if (!/^-?\d+$/.test(chatId)) continue;
      const v = value as Partial<ChatMessages>;
      chats[chatId] = { render: ids(v?.render), cards: ids(v?.cards) };
    }
    const offset = Number.isSafeInteger(parsed.offset) && (parsed.offset as number) >= 0 ? parsed.offset as number : 0;
    return { offset, chats };
  } catch {
    log.warn(`${BRIDGE_STATE_ROW} is not valid JSON; starting from an empty state`);
    return { offset: 0, chats: {} };
  }
}

/** Holds the state in memory and writes the row on every change (each is a handful of bytes). */
export class BridgeStateStore {
  private state: BridgeState;

  constructor(initial: BridgeState = readBridgeState()) {
    this.state = initial;
  }

  get offset(): number {
    return this.state.offset;
  }

  setOffset(offset: number): void {
    if (offset === this.state.offset) return;
    this.state.offset = offset;
    this.save();
  }

  add(chatId: string, kind: keyof ChatMessages, messageId: number): void {
    const chat = this.state.chats[chatId] ??= { render: [], cards: [] };
    if (chat[kind].includes(messageId)) return;
    chat[kind] = [...chat[kind], messageId].slice(-MAX_IDS_PER_CHAT);
    this.save();
  }

  remove(chatId: string, kind: keyof ChatMessages, messageId: number): void {
    const chat = this.state.chats[chatId];
    if (!chat?.[kind].includes(messageId)) return;
    chat[kind] = chat[kind].filter((id) => id !== messageId);
    if (!chat.render.length && !chat.cards.length) delete this.state.chats[chatId];
    this.save();
  }

  /** Every chat's unfinished messages, removed from the state. */
  takeAll(): Record<string, ChatMessages> {
    const chats = this.state.chats;
    this.state.chats = {};
    this.save();
    return chats;
  }

  /** Drops what is remembered for one chat (it was disconnected). */
  forgetChat(chatId: string): void {
    if (!(chatId in this.state.chats)) return;
    delete this.state.chats[chatId];
    this.save();
  }

  private save(): void {
    try {
      setConfigValue(BRIDGE_STATE_ROW, JSON.stringify(this.state));
    } catch (e) {
      // Losing this costs a message that stays "…" after a crash, never a message or an answer.
      log.warn(`Could not save ${BRIDGE_STATE_ROW}: ${(e as Error).message}`);
    }
  }
}
