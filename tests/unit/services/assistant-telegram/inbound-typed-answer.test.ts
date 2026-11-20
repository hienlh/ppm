/**
 * The router hands a message to a question card's typed answer before anything else — before a
 * reply to an Assistant card, a task, or the Assistant itself — and only when the card takes it.
 * A message sent while PPM was off is never taken as an answer: it is asked about like any other.
 */
import { describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramInbound } from "../../../../src/services/assistant-telegram/assistant-telegram-inbound.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import type { TypedAnswerMessage } from "../../../../src/services/assistant-telegram/assistant-telegram-typed-answers.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

function router(typedAnswer: (chatId: string, m: TypedAnswerMessage) => string | null) {
  const seen: TypedAnswerMessage[] = [];
  const toCards: number[] = [];
  const queue = queueFor(client);
  const r = new AssistantTelegramInbound({
    client, token: fake.token, queue, codes: new ButtonCodes<BridgeAction>(),
    debounceMs: () => 0, delivered: () => {}, pressCard: () => "", switchSession: () => "", relayCard: () => {},
    typedAnswer: (chatId, m) => { seen.push(m); return typedAnswer(chatId, m); },
    isCardMessage: () => true,
    replyToCard: async (_chatId, m) => { toCards.push(m.replyToMessageId); return true; },
  });
  return { r, seen, toCards, queue };
}

describe("a typed answer to a question card, in the router", () => {
  it("is offered the message first; what the card says is the reply, and nothing goes on", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, seen, toCards, queue } = router(() => "✅ Answer sent: <b>mine</b>");
    r.dispatch(fake.pushText(chat, chat, "mine", "private", { reply_to_message: { message_id: 77, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000) } }));
    await r.settle();
    await queue.whenIdle();
    expect(seen).toEqual([{ text: "mine", replyToMessageId: 77, notTheUsers: false, hasPhoto: false }]);
    expect(toCards).toEqual([]);
    expect(fake.lastText(chat)).toBe("✅ Answer sent: mine");
  });

  it("lets the message go on when no card takes it", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, toCards } = router(() => null);
    r.dispatch(fake.pushText(chat, chat, "about the report", "private", { reply_to_message: { message_id: 78, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000) } }));
    await r.settle();
    expect(toCards).toEqual([78]);
  });

  it("never offers a message sent while PPM was off, or a command", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, seen } = router(() => "taken");
    r.dispatch(fake.pushText(chat, chat, "old words", "private", { date: Math.floor(Date.now() / 1000) - 3600 }));
    r.dispatch(fake.pushText(chat, chat, "/help"));
    await r.settle();
    expect(seen).toEqual([]);
  });
});
