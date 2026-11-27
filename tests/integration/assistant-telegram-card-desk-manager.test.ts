/**
 * A manager's card on the pinned card desk, against the fake Bot API: listed once Telegram has its
 * message, still there after a restart (with fresh buttons, its old codes having died with the old
 * process), and gone when it is answered. A "done" report never goes on the desk.
 */
import { afterAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { TelegramBotClient } from "../../src/services/telegram/telegram-bot-client.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { AssistantTelegramSendQueue } from "../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { ButtonCodes } from "../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { AssistantTelegramCardsDesk } from "../../src/services/assistant-telegram/assistant-telegram-cards-desk.ts";
import { memoryCardDeskStore, type CardDeskStore } from "../../src/services/assistant-telegram/assistant-telegram-cards-desk-store.ts";
import { AssistantTelegramManagerCards } from "../../src/services/assistant-telegram/assistant-telegram-manager-cards.ts";
import { casCardStatus, getCardRow, insertCardRow } from "../../src/services/assistant-cards/assistant-cards-db.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { upsertApprovedPairing } from "../../src/services/db.service.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { AssistantCard, AssistantCardKind } from "../../src/shared/assistant-cards.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;
afterAll(() => {
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
});

let nextChat = 9_200_000;

function rig(chat: number, store: CardDeskStore) {
  const chatId = String(chat);
  // Only a connected chat is ever sent a card.
  upsertApprovedPairing(chatId, chatId, "Phone");
  const client = new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {} });
  const codes = new ButtonCodes<BridgeAction>();
  const queue = new AssistantTelegramSendQueue(client, { canSend: () => true, scaleDelay: (ms) => ms / 1000 });
  let cards: AssistantTelegramManagerCards | null = null;
  const desk = new AssistantTelegramCardsDesk({
    queue, codes, store, enabled: () => true, restore: (c) => cards!.restoreDesk(c),
    timing: { debounceMs: 0, quietAfterUserMs: 0, minGapMs: 0, maxWaitMs: 0 },
  });
  cards = new AssistantTelegramManagerCards({
    queue, codes, desk,
    chatLink: async () => "http://localhost/chat", sessionLink: async () => "http://localhost/session",
    relayCard: () => {}, isShowing: () => false, recipients: () => [chatId], detailOf: () => "full",
  });
  return { chatId, desk, cards, codes, idle: () => queue.whenIdle() };
}

function newCard(kind: AssistantCardKind, title: string): AssistantCard {
  const row = insertCardRow({
    kind, projectKey: null, sessionId: null, title, body: "Pick the Telegram list style before Friday.",
    payload: {} as never, status: kind === "done" ? "info" : "open", wake: "none", at: Date.now(),
  });
  return assistantCards.toCard(row);
}

const pinnedText = (chat: number) => fake.sent(chat).find((m) => m.message_id === fake.pins(chat).at(-1))?.text ?? "";

describe("a manager's card on the desk", () => {
  it("is listed once sent, comes back after a restart, and leaves when answered", async () => {
    const chat = nextChat++;
    const store = memoryCardDeskStore();
    const first = rig(chat, store);
    const decision = newCard("needs_decision", "Which Telegram list style?");
    const report = newCard("done", "Release 0.26.40 shipped");
    first.cards.send([decision, report]);
    await fake.waitFor(() => pinnedText(chat).includes("Waiting for you (1)"));
    expect(pinnedText(chat)).toContain("🔔 Which Telegram list style?");
    expect(pinnedText(chat)).not.toContain("Release 0.26.40 shipped");
    const cardMessage = getCardRow(decision.id)!.telegramRefs.find((r) => r.chatId === String(chat))!.messageId;
    const desk = store.get(String(chat))!;
    expect(first.desk.replyFor(String(chat), desk, { sentAt: Date.now() + 1_000, text: "the first one" })).toMatchObject({ to: cardMessage });
    first.desk.stop();

    // A restart: the same desk message is edited, the card back on it from the database.
    const second = rig(chat, store);
    await second.desk.start([String(chat)]);
    await second.idle();
    expect(store.get(String(chat))).toBe(desk);
    expect(fake.pins(chat)).toEqual([desk]);
    expect(pinnedText(chat)).toContain("Which Telegram list style?");
    // After the restart the list is drawn again, and a reply is matched against that version.
    expect(second.desk.replyFor(String(chat), desk, { sentAt: Date.now() + 1_000, text: "the first one" })).toMatchObject({ to: cardMessage });

    // Answered in PPM: the card ends, and the desk with it.
    expect(casCardStatus(decision.id, "open", "answered", { ok: true } as never, Date.now())).toBe(true);
    second.cards.changed(assistantCards.toCard(getCardRow(decision.id)!));
    await second.idle();
    expect(pinnedText(chat)).toStartWith("✅ Nothing is waiting for you.");
    second.desk.stop();
  });
});
