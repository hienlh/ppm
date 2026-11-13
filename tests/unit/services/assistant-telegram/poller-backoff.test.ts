import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { AssistantTelegramPoller, pollRetryDelayMs } from "../../../../src/services/assistant-telegram/assistant-telegram-poller.ts";
import { BridgeStateStore } from "../../../../src/services/assistant-telegram/assistant-telegram-state.ts";
import type { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";

type Refusal = { ok: false; errorCode: number | null; description: string; retryAfter?: number };

/** A client whose every poll is refused the same way, counting the polls. */
function refusingClient(refusal: Refusal) {
  let polls = 0;
  const client = { getUpdates: async () => { polls++; return refusal; } } as unknown as TelegramBotClient;
  return { client, polls: () => polls };
}

describe("polling again after Telegram refuses", () => {
  it("waits as long as Telegram asks, up to five minutes, else 5 s after a conflict and 3 s otherwise", () => {
    expect(pollRetryDelayMs(429, 60)).toBe(60_000);
    expect(pollRetryDelayMs(429, 3600)).toBe(300_000);
    expect(pollRetryDelayMs(409)).toBe(5000);
    expect(pollRetryDelayMs(500)).toBe(3000);
    expect(pollRetryDelayMs(null)).toBe(3000);
  });

  it("hands the wait Telegram asked for to the pause between polls", async () => {
    const { client } = refusingClient({ ok: false, errorCode: 429, description: "Too Many Requests", retryAfter: 90 });
    const waits: number[] = [];
    const poller = new AssistantTelegramPoller(client, new BridgeStateStore({ offset: 0, chats: {} }), () => {}, (ms, signal) => {
      waits.push(ms);
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    poller.start(1);
    for (let i = 0; i < 100 && waits.length === 0; i++) await Bun.sleep(5);
    await poller.stop();
    expect(waits).toEqual([90_000]);
  });

  it("ends a back-off at once when the bridge stops", async () => {
    const { client, polls } = refusingClient({ ok: false, errorCode: 409, description: "Conflict" });
    const poller = new AssistantTelegramPoller(client, new BridgeStateStore({ offset: 0, chats: {} }), () => {});
    poller.start(1);
    await Bun.sleep(20);
    const t0 = Date.now();
    await poller.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(polls()).toBe(1);
  });
});
