import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";
import { startFakeTelegram, type FakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";

const CHAT = 4242;
const saved = process.env[TELEGRAM_API_BASE_ENV];
let fake: FakeTelegram;
let slept: number[];
let warn: ReturnType<typeof spyOn>;

const client = (options: ConstructorParameters<typeof TelegramBotClient>[1] = {}) =>
  new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async (ms) => { slept.push(ms); }, ...options });

beforeAll(() => {
  fake = startFakeTelegram();
  process.env[TELEGRAM_API_BASE_ENV] = fake.url;
});
afterAll(() => {
  fake.stop();
  if (saved === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
  else process.env[TELEGRAM_API_BASE_ENV] = saved;
});
beforeEach(() => {
  slept = [];
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

/** Every warning logged during the test, as one string. */
const warnings = () => warn.mock.calls.flat().join("\n");

describe("TelegramBotClient", () => {
  it("refuses a malformed token", () => {
    expect(() => new TelegramBotClient("nope")).toThrow("Invalid Telegram bot token format");
  });

  it("sends HTML with buttons and a reply, and reads messages and button presses", async () => {
    const bot = client();
    const sent = await bot.sendMessage(CHAT, "<b>Allow?</b>", {
      replyMarkup: { inline_keyboard: [[{ text: "Allow", callback_data: "a:1" }, { text: "Deny", callback_data: "d:1" }]] },
      replyTo: 7,
    });
    expect(sent.ok).toBe(true);
    const id = sent.ok ? sent.result.message_id : -1;
    expect(fake.lastText(CHAT)).toBe("Allow?");
    expect(fake.sent(CHAT).at(-1)!.reply_to).toBe(7);
    expect(fake.buttons(CHAT, id).flat().map((b) => b.callback_data)).toEqual(["a:1", "d:1"]);

    fake.pushText(CHAT, CHAT, "hello");
    fake.pressButton(CHAT, CHAT, id, "a:1");
    const updates = await bot.getUpdates(0, 1);
    expect(updates.ok).toBe(true);
    const got = updates.ok ? updates.result : [];
    expect(got.map((u) => (u.message ? "message" : "callback_query"))).toEqual(["message", "callback_query"]);
    expect(got[1]!.callback_query!.data).toBe("a:1");
    expect(fake.calls.findLast((c) => c.method === "getUpdates")!.body.allowed_updates).toEqual(["message", "callback_query"]);

    expect((await bot.answerCallbackQuery(got[1]!.callback_query!.id, "Allowed")).ok).toBe(true);
    expect(fake.answers.at(-1)).toEqual({ callback_query_id: got[1]!.callback_query!.id, text: "Allowed" });
    // Confirm, so the next test starts from an empty queue.
    await bot.getUpdates(got.at(-1)!.update_id + 1, 0);
  });

  it("waits out a 429 once and retries", async () => {
    fake.failNext("sendMessage", { code: 429, retryAfter: 3 });
    const res = await client().sendMessage(CHAT, "after the wait");
    expect(res.ok).toBe(true);
    expect(slept).toEqual([3000]);
    expect(fake.lastText(CHAT)).toBe("after the wait");
  });

  it("gives up on a 429 that asks for longer than it will wait", async () => {
    fake.failNext("sendMessage", { code: 429, retryAfter: 120 });
    const res = await client().sendMessage(CHAT, "never");
    expect(res).toMatchObject({ ok: false, errorCode: 429, retryAfter: 120 });
    expect(slept).toEqual([]);
    expect(warnings()).toContain("sendMessage failed: 429");
  });

  it("resends as plain text when Telegram cannot parse the HTML", async () => {
    const res = await client().sendMessage(CHAT, "<b>a < b</b> &amp; <i>c</i>");
    expect(res.ok).toBe(true);
    const last = fake.sent(CHAT).at(-1)!;
    expect(last.text).toBe("a < b & c");
    expect(last.parse_mode).toBeUndefined();
    expect(warnings()).toContain("resending as plain text");
  });

  it("spaces out edits of one message, but never a final one", async () => {
    const bot = client({ editIntervalMs: 60_000 });
    const sent = await bot.sendMessage(CHAT, "draft 0");
    const id = sent.ok ? sent.result.message_id : -1;
    expect((await bot.editMessageText(CHAT, id, "draft 1")).ok).toBe(true);
    expect(await bot.editMessageText(CHAT, id, "draft 2")).toEqual({ ok: false, throttled: true });
    expect((await bot.editMessageText(CHAT, id, "final", { final: true })).ok).toBe(true);
    expect(fake.sent(CHAT).find((m) => m.message_id === id)!.history).toEqual(["draft 0", "draft 1"]);
    expect(fake.lastText(CHAT)).toBe("final");
  });

  it("counts an edit that changes nothing as done, and removes buttons", async () => {
    const bot = client();
    const sent = await bot.sendMessage(CHAT, "same", { replyMarkup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } });
    const id = sent.ok ? sent.result.message_id : -1;
    expect((await bot.editMessageText(CHAT, id, "same", { replyMarkup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } })).ok).toBe(true);
    expect((await bot.editMessageReplyMarkup(CHAT, id, null)).ok).toBe(true);
    expect(fake.buttons(CHAT, id)).toEqual([]);
    expect(warnings()).toBe("");
  });

  it("deletes a message, and counts one already gone as deleted", async () => {
    const bot = client();
    const sent = await bot.sendMessage(CHAT, "draft to drop");
    const id = sent.ok ? sent.result.message_id : -1;
    expect((await bot.deleteMessage(CHAT, id)).ok).toBe(true);
    expect(fake.sent(CHAT).some((m) => m.message_id === id)).toBe(false);
    expect(fake.deleted.at(-1)!.text).toBe("draft to drop");
    expect((await bot.deleteMessage(CHAT, id)).ok).toBe(true);
    fake.failNext("deleteMessage", { code: 400, description: "Bad Request: message can't be deleted" });
    expect(await bot.deleteMessage(CHAT, 1)).toMatchObject({ ok: false, errorCode: 400 });
    expect(warnings()).not.toContain("message to delete not found");
  });

  it("reports a refusal with its code and description only", async () => {
    const res = await client().editMessageText(CHAT, 99_999, "gone", { final: true });
    expect(res).toMatchObject({ ok: false, errorCode: 400, description: "Bad Request: message to edit not found" });
    expect(warnings()).toContain("editMessageText failed: 400 Bad Request: message to edit not found");
    expect(warnings()).not.toContain(fake.token);
  });

  it("downloads a photo within the size limit and refuses a larger one", async () => {
    const bot = client();
    const bytes = new Uint8Array(2048).fill(7);
    fake.pushPhoto(CHAT, CHAT, { bytes, caption: "error screen" });
    const updates = await bot.getUpdates(0, 1);
    const message = updates.ok ? updates.result[0]!.message! : null;
    expect(message?.caption).toBe("error screen");
    const largest = message!.photo!.at(-1)!;
    const file = await bot.getFile(largest.file_id);
    expect(file.ok).toBe(true);
    const path = file.ok ? file.result.file_path! : "";
    const got = await bot.downloadFile(path, 4096);
    expect(got.ok && Array.from(got.result)).toEqual(Array.from(bytes));
    expect(await bot.downloadFile(path, 1000)).toMatchObject({ ok: false, description: "file too large" });
    expect(await bot.downloadFile("../etc/passwd", 1000)).toMatchObject({ ok: false, description: "unexpected file path" });
    await bot.getUpdates(updates.ok ? updates.result.at(-1)!.update_id + 1 : 0, 0);
  });

  it("registers commands and sends a chat action", async () => {
    const bot = client();
    expect((await bot.setMyCommands([{ command: "new", description: "Start a new conversation" }])).ok).toBe(true);
    expect(fake.commands).toEqual([{ command: "new", description: "Start a new conversation" }]);
    expect((await bot.sendChatAction(CHAT)).ok).toBe(true);
  });

  it("never puts the token in what it returns or logs when Telegram cannot be reached", async () => {
    const dead = startFakeTelegram();
    const url = dead.url;
    dead.stop();
    process.env[TELEGRAM_API_BASE_ENV] = url;
    try {
      const res = await client({ requestTimeoutMs: 2000 }).sendMessage(CHAT, "x");
      expect(res).toMatchObject({ ok: false, errorCode: null });
      expect(JSON.stringify(res)).not.toContain(fake.token);
      expect(warnings()).toContain("sendMessage could not reach Telegram");
      expect(warnings()).not.toContain(fake.token);
    } finally {
      process.env[TELEGRAM_API_BASE_ENV] = fake.url;
    }
  });

  it("does not log a failed poll: the poll loop reports for itself", async () => {
    fake.failNext("getUpdates", { code: 409, description: "Conflict: terminated by other getUpdates request" });
    const res = await client().getUpdates(0, 0);
    expect(res).toMatchObject({ ok: false, errorCode: 409 });
    expect(warnings()).toBe("");
  });
});
