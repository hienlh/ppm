import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";
import { startFakeTelegram, type FakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";

/** `sendPhotos`: one picture as a photo, several as one album, captions in Telegram's HTML. */

const CHAT = 4343;
const saved = process.env[TELEGRAM_API_BASE_ENV];
let fake: FakeTelegram;
const png = (n: number) => new Uint8Array(n).fill(7);

beforeAll(() => {
  fake = startFakeTelegram();
  process.env[TELEGRAM_API_BASE_ENV] = fake.url;
});
afterAll(() => {
  fake.stop();
  if (saved === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
  else process.env[TELEGRAM_API_BASE_ENV] = saved;
});

describe("TelegramBotClient.sendPhotos", () => {
  it("sends one picture with sendPhoto, silently when asked", async () => {
    const bot = new TelegramBotClient(fake.token);
    const res = await bot.sendPhotos(CHAT, [{ bytes: png(10), filename: "1-index.html.png", caption: "<b>1.</b> Kho" }], { silent: true });
    expect(res.ok).toBe(true);
    const last = fake.sent(CHAT).at(-1)!;
    expect(last).toMatchObject({ text: "1. Kho", silent: true, photo: { bytes: 10, filename: "1-index.html.png" } });
    expect(fake.calls.at(-1)!.method).toBe("sendPhoto");
  });

  it("sends several as one album, each with its own caption", async () => {
    const bot = new TelegramBotClient(fake.token);
    const res = await bot.sendPhotos(CHAT, [
      { bytes: png(5), filename: "a.png", caption: "<b>1.</b> A" },
      { bytes: png(6), filename: "b.png", caption: '<b>2.</b> B\n<a href="https://x.test/b.png">Open full size</a>' },
    ]);
    expect(res.ok && res.result.length).toBe(2);
    const sent = fake.sent(CHAT).slice(-2);
    expect(sent.map((m) => m.text)).toEqual(["1. A", "2. B\nOpen full size"]);
    expect(sent[0]!.photo!.album).toBe(sent[1]!.photo!.album);
    expect(fake.calls.at(-1)!.method).toBe("sendMediaGroup");
  });

  it("refuses no pictures, more than ten, and one over 10 MB without calling Telegram", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bot = new TelegramBotClient(fake.token);
      const before = fake.calls.length;
      expect((await bot.sendPhotos(CHAT, [])).ok).toBe(false);
      expect((await bot.sendPhotos(CHAT, Array.from({ length: 11 }, (_, i) => ({ bytes: png(1), filename: `${i}.png` })))).ok).toBe(false);
      expect((await bot.sendPhotos(CHAT, [{ bytes: png(10 * 1024 * 1024 + 1), filename: "big.png" }])).ok).toBe(false);
      expect(fake.calls.length).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });
});
