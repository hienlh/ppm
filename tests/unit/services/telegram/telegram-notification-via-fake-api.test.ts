/**
 * A Telegram notification sent end to end against the fake Bot API: the notification side
 * builds its URLs from the same base as everything else, so it follows `PPM_TELEGRAM_API_BASE`
 * and its HTML is what Telegram accepts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { addNotifyChat, listNotifyChats } from "../../../../src/services/telegram-bots.ts";
import { telegramService } from "../../../../src/services/telegram-notification.service.ts";
import { tailscaleAppService } from "../../../../src/services/tailscale/tailscale-app-service.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import { startFakeTelegram, type FakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";

const originals = { telegram: configService.get("telegram"), readState: tailscaleAppService.readState };
const savedBase = process.env[TELEGRAM_API_BASE_ENV];
let fake: FakeTelegram;

beforeAll(() => {
  fake = startFakeTelegram();
  process.env[TELEGRAM_API_BASE_ENV] = fake.url;
  // The notification link would otherwise ask the real Tailscale where PPM is.
  tailscaleAppService.readState = async () => { throw new Error("no Tailscale in this test"); };
});
afterAll(() => {
  fake.stop();
  if (savedBase === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
  else process.env[TELEGRAM_API_BASE_ENV] = savedBase;
  tailscaleAppService.readState = originals.readState;
  configService.set("telegram", originals.telegram!);
});
beforeEach(() => {
  setDb(openTestDb());
  configService.set("telegram", { bot_token: fake.token, bot_username: "ppm_fake_bot" });
  listNotifyChats();
  addNotifyChat({ chatId: "40", userId: "40", name: "Alerts" });
});

describe("Telegram notifications through the fake Bot API", () => {
  it("deliver a notification Telegram can parse", async () => {
    const result = await telegramService.send({
      title: "Done <fast> & clean",
      body: "Finished in api",
      project: "",
      sessionId: "",
      detail: "a < b",
      detailStyle: "code",
    });
    expect(result).toBe("sent=1");
    const [message] = fake.sent(40);
    expect(message!.parse_mode).toBe("HTML");
    expect(message!.text).toContain("Done <fast> & clean");
    expect(message!.text).toContain("a < b");
  });

  it("deliver the test message, and report Telegram's refusal in its own words", async () => {
    expect(await telegramService.sendTest(fake.token)).toEqual({ ok: true });
    expect(fake.lastText(40)).toContain("Telegram notifications are working!");

    fake.failNext("sendMessage", { code: 403, description: "Forbidden: bot was blocked by the user" });
    const blocked = await telegramService.sendTest(fake.token);
    expect(blocked).toEqual({ ok: false, error: "Forbidden: bot was blocked by the user" });
  });
});
