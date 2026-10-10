/**
 * Shared set-up for the Telegram bridge's tests: a fake Bot API every client in the process
 * talks to, connected chats, and a send queue whose waits are a thousand times shorter.
 */
import "../../../test-setup.ts";
import { afterAll } from "bun:test";
import { revokePairing, upsertApprovedPairing } from "../../../../src/services/db.service.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";
import { canSendTo } from "../../../../src/services/assistant-telegram/assistant-telegram-access.ts";
import { AssistantTelegramSendQueue } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { BridgeStateStore } from "../../../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { startFakeTelegram, type FakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";

/** A fake Bot API for the whole test file, stopped after it. */
export function useFakeTelegram(): FakeTelegram {
  const fake = startFakeTelegram();
  process.env[TELEGRAM_API_BASE_ENV] = fake.url;
  afterAll(() => {
    fake.stop();
    delete process.env[TELEGRAM_API_BASE_ENV];
  });
  return fake;
}

/** A private chat connected by its own user, as a connect link leaves it. */
export function connectChat(chatId: number, userId: number | string = chatId): string {
  upsertApprovedPairing(String(chatId), String(userId), `User${chatId}`);
  return String(chatId);
}

export function disconnectChat(chatId: number | string): void {
  revokePairing(String(chatId));
}

let nextChat = 7_000_000;
/** A chat id no other test in the process uses. */
export const freshChat = (): number => nextChat++;

export function clientFor(fake: FakeTelegram): TelegramBotClient {
  // Edits are not spaced out: the tests would otherwise wait a second per edit.
  return new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {} });
}

export function queueFor(client: TelegramBotClient, canSend: (chatId: string) => boolean = canSendTo): AssistantTelegramSendQueue {
  return new AssistantTelegramSendQueue(client, { canSend, scaleDelay: (ms) => ms / 1000 });
}

export function memoryState(): BridgeStateStore {
  return new BridgeStateStore({ offset: 0, chats: {} });
}

/** The visible text of every message the bot sent to a chat, as it stands now. */
export const texts = (fake: FakeTelegram, chatId: number | string) => fake.sent(Number(chatId)).map((m) => m.text);
