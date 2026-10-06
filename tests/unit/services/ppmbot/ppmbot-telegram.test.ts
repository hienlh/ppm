import { describe, it, expect, afterEach, spyOn } from "bun:test";
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

describe("PPMBot Telegram — getUpdates refusal log", () => {
  const TOKEN = "123456:ABCDEFghijklmnopqrstuvwxyz1234567890";
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("logs a refusal once, then once a minute with a count, and says when polling works again", async () => {
    let answer: unknown = { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" };
    globalThis.fetch = (async () => new Response(JSON.stringify(answer))) as unknown as typeof fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const info = spyOn(console, "log").mockImplementation(() => {});
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    const lines = (spy: typeof warn) => spy.mock.calls.map((c) => c.map(String).join(" "));
    try {
      const tg = new PPMBotTelegram(TOKEN);
      const poll = () => (tg as unknown as { getUpdates(): Promise<unknown[]> }).getUpdates();

      expect(await poll()).toEqual([]);
      await poll();
      await poll();
      expect(lines(warn).filter((l) => l.includes("getUpdates refused"))).toEqual([
        "[ppmbot] getUpdates refused: 409 Conflict: terminated by other getUpdates request",
      ]);

      now.mockReturnValue(1_000_000 + 60_000);
      await poll();
      expect(lines(warn).filter((l) => l.includes("getUpdates refused"))[1]).toContain("(2 more since the last line)");

      answer = { ok: true, result: [] };
      await poll();
      expect(lines(info).some((l) => l.includes("getUpdates accepted again"))).toBe(true);

      // A revoked token is an error, and a new refusal is logged at once.
      answer = { ok: false, error_code: 401, description: "Unauthorized" };
      await poll();
      expect(lines(error).filter((l) => l.includes("getUpdates refused"))).toEqual(["[ppmbot] getUpdates refused: 401 Unauthorized"]);

      // The token is in the request URL and must never reach a log line.
      for (const l of [...lines(warn), ...lines(error), ...lines(info)]) expect(l).not.toContain(TOKEN.split(":")[1]!);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
      now.mockRestore();
    }
  });
});
