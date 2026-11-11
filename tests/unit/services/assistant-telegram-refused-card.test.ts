/**
 * A card Telegram refuses for good (a 400, such as "message is too long") is tried once, dropped
 * and reported to the sender, never retried for the fifteen minutes a final message gets for a
 * limit or a network failure. The card's sink records the reason (`outbound_error`).
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { AssistantTelegramSendQueue, sendMessageTask } from "../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import type { TelegramBotClient } from "../../../src/services/telegram/telegram-bot-client.ts";
import { assistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { getCardOutboundError, setCardOutboundError } from "../../../src/services/assistant-cards/assistant-cards-outbound-db.ts";

describe("a card Telegram refuses", () => {
  it("is sent once and dropped with the reason, not retried", async () => {
    let calls = 0;
    const client = {
      async sendMessage() {
        calls++;
        return { ok: false, errorCode: 400, description: "Bad Request: message is too long" };
      },
    } as unknown as TelegramBotClient;
    const queue = new AssistantTelegramSendQueue(client, { canSend: () => true, scaleDelay: () => 1 });
    const dropped: string[] = [];
    queue.enqueue("42", sendMessageTask(queue, "42", { html: "x" }, { label: "card", onDropped: (why) => dropped.push(why) }));
    await queue.whenIdle();
    expect(calls).toBe(1);
    expect(dropped).toEqual(["400 Bad Request: message is too long"]);
  });

  it("keeps the reason on the card", () => {
    const card = assistantCards.create({ kind: "done", projectName: null, projectPath: null, sessionId: null, title: "Built" });
    expect(getCardOutboundError(card.id)).toBeNull();
    setCardOutboundError(card.id, "400 Bad Request: message is too long", 1);
    expect(getCardOutboundError(card.id)).toBe("400 Bad Request: message is too long");
  });
});
