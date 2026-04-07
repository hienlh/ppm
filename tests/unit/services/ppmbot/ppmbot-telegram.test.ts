import { describe, it, expect } from "bun:test";
import { PPMBotTelegram } from "../../../../src/services/ppmbot/ppmbot-telegram.ts";
import type { TelegramMessage } from "../../../../src/types/ppmbot.ts";

describe("PPMBot Telegram — parseCommand", () => {
  const makeMessage = (text: string): TelegramMessage => ({
    message_id: 1,
    chat: { id: 123, type: "private" },
    date: Date.now(),
    text,
    from: { id: 456, first_name: "Test", username: "testuser" },
  });

  it("should parse /start command", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("/start"));
    expect(cmd?.command).toBe("start");
    expect(cmd?.args).toBe("");
  });

  it("should parse /status command", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("/status"));
    expect(cmd?.command).toBe("status");
  });

  it("should parse /help command", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("/help"));
    expect(cmd?.command).toBe("help");
  });

  it("should parse /restart command (hidden)", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("/restart"));
    expect(cmd?.command).toBe("restart");
  });

  it("should handle @botname suffix", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("/status@ppmbot"));
    expect(cmd?.command).toBe("status");
  });

  it("should return null for non-command messages", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("hello world"));
    expect(cmd).toBeNull();
  });

  it("should return null for removed commands (now handled by coordinator NL)", () => {
    const removedCommands = ["project", "new", "sessions", "resume", "stop", "memory", "forget", "remember", "version"];
    for (const name of removedCommands) {
      const cmd = PPMBotTelegram.parseCommand(makeMessage(`/${name}`));
      expect(cmd).toBeNull();
    }
  });

  it("should parse all 4 known commands", () => {
    const commands = ["start", "status", "help", "restart"];
    for (const name of commands) {
      const cmd = PPMBotTelegram.parseCommand(makeMessage(`/${name}`));
      expect(cmd?.command).toBe(name);
    }
  });

  it("should extract chatId and userId", () => {
    const cmd = PPMBotTelegram.parseCommand(makeMessage("/start"));
    expect(cmd?.chatId).toBe(123);
    expect(cmd?.userId).toBe(456);
    expect(cmd?.username).toBe("testuser");
  });
});

describe("PPMBot Telegram — constructor", () => {
  it("should reject invalid bot token", () => {
    expect(() => new PPMBotTelegram("invalid")).toThrow("Invalid Telegram bot token");
  });

  it("should accept valid bot token", () => {
    const tg = new PPMBotTelegram("123456:ABCDEFghijklmnopqrstuvwxyz1234567890");
    expect(tg).toBeTruthy();
  });
});
