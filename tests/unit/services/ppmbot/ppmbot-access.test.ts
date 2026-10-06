/**
 * Who PPMBot answers: only chats connected with a link from Settings → PPMBot, as with
 * Notifications. Anyone else is told once how to connect, and nothing is recorded for them —
 * no pairing code, no request waiting for approval.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { listPairedChats, openTestDb, revokePairing, setDb, upsertApprovedPairing } from "../../../../src/services/db.service.ts";
import { ppmbotService } from "../../../../src/services/ppmbot/ppmbot-service.ts";
import type { TelegramUpdate } from "../../../../src/types/ppmbot.ts";

/** What a test drives: the private update handler, with a stand-in for the bot it replies through. */
const service = ppmbotService as unknown as {
  telegram: { sendMessage(chatId: number, html: string): Promise<unknown> } | null;
  handleUpdate(update: TelegramUpdate): Promise<void>;
};

let sent: Array<{ chatId: number; html: string }>;
beforeEach(() => {
  setDb(openTestDb());
  sent = [];
  service.telegram = { sendMessage: async (chatId, html) => { sent.push({ chatId, html }); } };
});
afterAll(() => {
  service.telegram = null;
});

let nextId = 1;
const update = (text: string, chatId: number): TelegramUpdate => ({
  update_id: nextId++,
  message: { message_id: nextId, date: 0, text, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Someone" } },
});

describe("a chat writing to PPMBot's bot", () => {
  it("is told how to connect when it is not connected, once, and nothing is recorded for it", async () => {
    await service.handleUpdate(update("/start", 501));
    await service.handleUpdate(update("hello?", 501));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(501);
    expect(sent[0]!.html).toContain("Connect Telegram");
    expect(sent[0]!.html).not.toMatch(/code/i);
    expect(listPairedChats()).toEqual([]);
  });

  it("is answered once connected, and told again after it is disconnected", async () => {
    await service.handleUpdate(update("/status", 502));
    upsertApprovedPairing("502", "502", "Owner");
    await service.handleUpdate(update("/status", 502));
    revokePairing("502");
    await service.handleUpdate(update("/status", 502));
    expect(sent.map((m) => m.html)).toEqual([
      expect.stringContaining("not connected"),
      expect.stringContaining("PPMBot Status"),
      expect.stringContaining("not connected"),
    ]);
  });
});
