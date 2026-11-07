import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { PPMBotTelegram, TelegramPollRefused } from "../../../../src/services/ppmbot/ppmbot-telegram.ts";
import type { TelegramMessage, TelegramUpdate } from "../../../../src/types/ppmbot.ts";

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

      await expect(poll()).rejects.toBeInstanceOf(TelegramPollRefused);
      await expect(poll()).rejects.toBeInstanceOf(TelegramPollRefused);
      await expect(poll()).rejects.toBeInstanceOf(TelegramPollRefused);
      expect(lines(warn).filter((l) => l.includes("getUpdates refused"))).toEqual([
        "[ppmbot] getUpdates refused: 409 Conflict: terminated by other getUpdates request",
      ]);

      now.mockReturnValue(1_000_000 + 60_000);
      await expect(poll()).rejects.toBeInstanceOf(TelegramPollRefused);
      expect(lines(warn).filter((l) => l.includes("getUpdates refused"))[1]).toContain("(2 more since the last line)");

      answer = { ok: true, result: [] };
      await poll();
      expect(lines(info).some((l) => l.includes("getUpdates accepted again"))).toBe(true);

      // A revoked token is an error, and a new refusal is logged at once.
      answer = { ok: false, error_code: 401, description: "Unauthorized" };
      await expect(poll()).rejects.toBeInstanceOf(TelegramPollRefused);
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

describe("PPMBot Telegram — poll backoff", () => {
  const TOKEN = "123456:ABCDEFghijklmnopqrstuvwxyz1234567890";
  const realFetch = globalThis.fetch;
  let tg: PPMBotTelegram | undefined;
  let warn: ReturnType<typeof spyOn<typeof console, "warn">> | undefined;

  afterEach(() => {
    tg?.stop();
    tg = undefined;
    globalThis.fetch = realFetch;
    warn?.mockRestore();
    warn = undefined;
  });

  function mockPoll(poll: (init?: RequestInit) => Response | Promise<Response>): void {
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith("/setMyCommands")) return Response.json({ ok: true });
      return poll(init);
    }) as typeof fetch;
  }

  function refused(code = 409, retryAfter?: number): Response {
    return Response.json({ ok: false, error_code: code, parameters: { retry_after: retryAfter } });
  }

  async function resolvesPromptly(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("poll did not stop within 500ms")), 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("backs off refusals, resets after an update and respects retry_after", async () => {
    const update: TelegramUpdate = { update_id: 42 };
    const replies = [refused(), refused(), refused(), Response.json({ ok: true, result: [update] }), refused(), refused(429, 7)];
    const delays: number[] = [];
    const received: TelegramUpdate[] = [];
    warn = spyOn(console, "warn").mockImplementation(() => {});
    mockPoll(() => {
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected extra poll");
      return reply;
    });
    tg = new PPMBotTelegram(TOKEN, { sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 5) tg!.stop();
    } });
    await tg.startPolling(async (value) => { received.push(value); });
    expect(delays).toEqual([2000, 4000, 8000, 2000, 7000]);
    expect(received).toEqual([update]);
    expect(replies).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Poll error");
  });

  it("caps seven consecutive refusals at 30 seconds", async () => {
    const delays: number[] = [];
    mockPoll(() => refused());
    tg = new PPMBotTelegram(TOKEN, { sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 7) tg!.stop();
    } });
    await tg.startPolling(async () => {});
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("caps retry_after at five minutes and still counts that refusal toward backoff", async () => {
    const replies = [refused(429, 600), refused(429, 0), refused(429, -1)];
    const delays: number[] = [];
    mockPoll(() => replies.shift()!);
    tg = new PPMBotTelegram(TOKEN, { sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 3) tg!.stop();
    } });
    await tg.startPolling(async () => {});
    expect(delays).toEqual([300000, 4000, 8000]);
  });

  it("logs network errors and backs off before retrying", async () => {
    const delays: number[] = [];
    warn = spyOn(console, "warn").mockImplementation(() => {});
    mockPoll(() => { throw new Error("network unavailable"); });
    tg = new PPMBotTelegram(TOKEN, { sleep: async (ms) => {
      delays.push(ms);
      tg!.stop();
    } });
    await tg.startPolling(async () => {});
    expect(delays).toEqual([2000]);
    expect(warn.mock.calls.flat().join(" ")).toContain("Poll error (retry 1): network unavailable");
  });

  it("resets backoff on an accepted poll even without result", async () => {
    const replies = [refused(), Response.json({ ok: true }), refused()];
    const delays: number[] = [];
    mockPoll(() => replies.shift()!);
    tg = new PPMBotTelegram(TOKEN, { sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 2) tg!.stop();
    } });
    await tg.startPolling(async () => {});
    expect(delays).toEqual([2000, 2000]);
  });

  it("interrupts the default two-second sleep when stopped", async () => {
    let polled!: () => void;
    const firstPoll = new Promise<void>((resolve) => { polled = resolve; });
    let polls = 0;
    mockPoll(() => {
      polls++;
      polled();
      return refused();
    });
    tg = new PPMBotTelegram(TOKEN);
    let finished = false;
    const loop = tg.startPolling(async () => {}).then(() => { finished = true; });
    await firstPoll;
    // Let the refusal reach the 2 s default sleep before asking it to stop; a
    // stop that lands earlier would pass without testing the sleep at all.
    await Bun.sleep(20);
    expect(finished).toBe(false);
    const started = performance.now();
    tg.stop();
    await resolvesPromptly(loop);
    expect(performance.now() - started).toBeLessThan(500);
    expect(polls).toBe(1);
  });

  it("keeps the old loop stopped when restarted during its sleep", async () => {
    let polled!: () => void;
    const firstPoll = new Promise<void>((resolve) => { polled = resolve; });
    let restarted!: () => void;
    const nextPoll = new Promise<void>((resolve) => { restarted = resolve; });
    let polls = 0;
    mockPoll((init) => {
      polls++;
      if (polls === 1) {
        polled();
        return refused();
      }
      restarted();
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(new Error("poll aborted"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    tg = new PPMBotTelegram(TOKEN);
    const oldLoop = tg.startPolling(async () => {});
    await firstPoll;
    await Bun.sleep(0);
    tg.stop();
    let newFinished = false;
    const newLoop = tg.startPolling(async () => {}).then(() => { newFinished = true; });
    try {
      await resolvesPromptly(oldLoop);
      await resolvesPromptly(nextPoll);
      expect(tg.isRunning).toBe(true);
      expect(newFinished).toBe(false);
      expect(polls).toBe(2);
    } finally {
      tg.stop();
      await resolvesPromptly(newLoop);
    }
    expect(newFinished).toBe(true);
  });
});
