/**
 * The Assistant hub's one startup: watches always, the Telegram bridge only when switched on with
 * a bot; a second call starts nothing twice, and stopping leaves nothing reading Telegram.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { assistantWatchService } from "../../../src/services/assistant-watch/assistant-watch.service.ts";
import { assistantTelegramBridge } from "../../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { PPMBOT_MIGRATED_KEY } from "../../../src/services/assistant-telegram/ppmbot-migration.ts";
import { startAssistantHub, stopAssistantHub, syncAssistantTelegram } from "../../../src/services/assistant-hub/assistant-hub-startup.ts";
import { setPPMBotBot } from "../../../src/services/telegram-bots.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../src/services/telegram/telegram-api-base.ts";
import { startFakeTelegram } from "../../helpers/fake-telegram-bot-api.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;
const original = configService.get("clawbot");
const bridge = { client: { editIntervalMs: 0, sleep: async () => {} }, pollTimeoutS: 1, scaleDelay: (ms: number) => ms / 1000 };

afterEach(async () => { await stopAssistantHub(); });
afterAll(() => {
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
  configService.set("clawbot", original!);
  setPPMBotBot({ bot_token: "" });
  getDb().query("DELETE FROM config WHERE key = ?").run(PPMBOT_MIGRATED_KEY);
});

const polls = () => fake.calls.filter((c) => c.method === "getUpdates");

describe("startAssistantHub", () => {
  it("starts the watches, and not the bridge while it is switched off", async () => {
    configService.set("clawbot", { enabled: false, show_tool_calls: true, debounce_ms: 2000 });
    setPPMBotBot({ bot_token: fake.token });
    await startAssistantHub({ bridge });
    expect(assistantWatchService.running).toBe(true);
    expect(assistantTelegramBridge.running).toBe(false);
  });

  it("does not start the bridge without a bot, switched on or not", async () => {
    configService.set("clawbot", { enabled: true, show_tool_calls: true, debounce_ms: 2000 });
    setPPMBotBot({ bot_token: "" });
    await startAssistantHub({ bridge });
    expect(assistantWatchService.running).toBe(true);
    expect(assistantTelegramBridge.running).toBe(false);
  });

  it("starts the bridge once when switched on with a bot, and stops both cleanly", async () => {
    configService.set("clawbot", { enabled: true, show_tool_calls: true, debounce_ms: 2000 });
    setPPMBotBot({ bot_token: fake.token });
    const info = spyOn(console, "log");
    try {
      await Promise.all([startAssistantHub({ bridge }), startAssistantHub({ bridge })]);
      expect(assistantWatchService.running).toBe(true);
      expect(assistantTelegramBridge.running).toBe(true);
      await fake.waitFor(() => polls().length > 0);
      // One reader: Telegram would answer a second one with 409.
      await Bun.sleep(50);
      expect(fake.calls.filter((c) => c.method === "getUpdates" && c.failed === 409)).toHaveLength(0);
      expect(info.mock.calls.flat().join("\n")).toContain("Assistant Telegram started");
      expect(info.mock.calls.flat().join("\n")).not.toContain("[ppmbot]");
    } finally {
      info.mockRestore();
    }
    await stopAssistantHub();
    expect(assistantWatchService.running).toBe(false);
    expect(assistantTelegramBridge.running).toBe(false);
    // Nothing reads the bot any more: no poll goes out after the stop.
    const after = polls().length;
    await Bun.sleep(1200);
    expect(polls().length).toBe(after);
  });

  it("follows the switch afterwards", async () => {
    configService.set("clawbot", { enabled: false, show_tool_calls: true, debounce_ms: 2000 });
    setPPMBotBot({ bot_token: fake.token });
    await startAssistantHub({ bridge });
    configService.set("clawbot", { enabled: true, show_tool_calls: true, debounce_ms: 2000 });
    await syncAssistantTelegram();
    expect(assistantTelegramBridge.running).toBe(true);
    configService.set("clawbot", { enabled: false, show_tool_calls: true, debounce_ms: 2000 });
    await syncAssistantTelegram();
    expect(assistantTelegramBridge.running).toBe(false);
  });
});
