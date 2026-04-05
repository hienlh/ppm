import { describe, it, expect } from "bun:test";
import { ClawBotTelegram } from "../../../../src/services/clawbot/clawbot-telegram.ts";
import type { TelegramMessage } from "../../../../src/types/clawbot.ts";

describe("ClawBot Telegram — parseCommand", () => {
  const makeMessage = (text: string): TelegramMessage => ({
    message_id: 1,
    chat: { id: 123, type: "private" },
    date: Date.now(),
    text,
    from: { id: 456, first_name: "Test", username: "testuser" },
  });

  it("should parse /start command", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/start"));
    expect(cmd?.command).toBe("start");
    expect(cmd?.args).toBe("");
  });

  it("should parse /project with args", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/project my-app"));
    expect(cmd?.command).toBe("project");
    expect(cmd?.args).toBe("my-app");
  });

  it("should parse /resume with number", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/resume 3"));
    expect(cmd?.command).toBe("resume");
    expect(cmd?.args).toBe("3");
  });

  it("should parse /remember with multi-word fact", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/remember the API uses REST not GraphQL"));
    expect(cmd?.command).toBe("remember");
    expect(cmd?.args).toBe("the API uses REST not GraphQL");
  });

  it("should handle @botname suffix", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/status@clawbot"));
    expect(cmd?.command).toBe("status");
  });

  it("should return null for non-command messages", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("hello world"));
    expect(cmd).toBeNull();
  });

  it("should return null for unknown commands", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/unknown"));
    expect(cmd).toBeNull();
  });

  it("should parse all 11 known commands", () => {
    const commands = [
      "start", "project", "new", "sessions", "resume",
      "status", "stop", "memory", "forget", "remember", "help",
    ];
    for (const name of commands) {
      const cmd = ClawBotTelegram.parseCommand(makeMessage(`/${name}`));
      expect(cmd?.command).toBe(name);
    }
  });

  it("should extract chatId and userId", () => {
    const cmd = ClawBotTelegram.parseCommand(makeMessage("/start"));
    expect(cmd?.chatId).toBe(123);
    expect(cmd?.userId).toBe(456);
    expect(cmd?.username).toBe("testuser");
  });
});

describe("ClawBot Telegram — constructor", () => {
  it("should reject invalid bot token", () => {
    expect(() => new ClawBotTelegram("invalid")).toThrow("Invalid Telegram bot token");
  });

  it("should accept valid bot token", () => {
    const tg = new ClawBotTelegram("123456:ABCDEFghijklmnopqrstuvwxyz1234567890");
    expect(tg).toBeTruthy();
  });
});
