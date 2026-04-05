import { describe, it, expect } from "bun:test";
import type { ChatEvent } from "../../../../src/types/chat.ts";
import type { StreamConfig } from "../../../../src/services/ppmbot/ppmbot-streamer.ts";

// We test streamToTelegram by providing a mock telegram object and a mock event iterable.

function makeEvents(events: ChatEvent[]): AsyncIterable<ChatEvent> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++]!, done: false };
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

function makeMockTelegram() {
  const sent: { chatId: number | string; text: string }[] = [];
  const edited: { chatId: number | string; msgId: number; text: string }[] = [];
  let msgIdCounter = 100;

  return {
    sent,
    edited,
    sendTyping: async () => {},
    sendMessage: async (chatId: number | string, text: string) => {
      const msg = { message_id: ++msgIdCounter };
      sent.push({ chatId, text });
      return msg;
    },
    editMessage: async (chatId: number | string, msgId: number, text: string) => {
      edited.push({ chatId, msgId, text });
    },
    editMessageFinal: async (chatId: number | string, msgId: number, text: string) => {
      edited.push({ chatId, msgId, text });
    },
  };
}

describe("PPMBot Streamer — streamToTelegram", () => {
  // Dynamic import to avoid module-level side effects
  let streamToTelegram: typeof import("../../../../src/services/ppmbot/ppmbot-streamer.ts").streamToTelegram;

  const loadModule = async () => {
    const mod = await import("../../../../src/services/ppmbot/ppmbot-streamer.ts");
    streamToTelegram = mod.streamToTelegram;
  };

  const defaultConfig: StreamConfig = {
    showToolCalls: true,
    showThinking: false,
  };

  it("should send placeholder and finalize with text", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "text", content: "Hello world" },
      { type: "done", sessionId: "s1", contextWindowPct: 20 },
    ]);

    const result = await streamToTelegram(123, events, tg as any, defaultConfig);

    expect(result.messageIds.length).toBeGreaterThanOrEqual(1);
    expect(result.contextWindowPct).toBe(20);
    // Should have sent placeholder + edited with final text
    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.edited.length).toBeGreaterThanOrEqual(1);
  });

  it("should include tool_use when showToolCalls=true", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "tool_use", tool: "Bash", input: { command: "ls" } },
      { type: "tool_result", output: "file1.txt", isError: false },
      { type: "text", content: "Done" },
      { type: "done", sessionId: "s1" },
    ]);

    await streamToTelegram(123, events, tg as any, { showToolCalls: true, showThinking: false });

    const allEdited = tg.edited.map((e) => e.text).join(" ");
    expect(allEdited).toContain("Bash");
  });

  it("should skip tool_use when showToolCalls=false", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "tool_use", tool: "Bash", input: { command: "ls" } },
      { type: "text", content: "Result" },
      { type: "done", sessionId: "s1" },
    ]);

    await streamToTelegram(123, events, tg as any, { showToolCalls: false, showThinking: false });

    // Tool calls should not appear since showToolCalls is false
    const allEdited = tg.edited.map((e) => e.text).join(" ");
    expect(allEdited).not.toContain("🔧");
  });

  it("should handle error events", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "text", content: "Partial" },
      { type: "error", message: "Something broke" },
      { type: "done", sessionId: "s1" },
    ]);

    await streamToTelegram(123, events, tg as any, defaultConfig);

    const allEdited = tg.edited.map((e) => e.text).join(" ");
    expect(allEdited).toContain("Something broke");
  });

  it("should capture session_migrated newSessionId", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "session_migrated", oldSessionId: "s1", newSessionId: "s2" },
      { type: "text", content: "Continued" },
      { type: "done", sessionId: "s2" },
    ]);

    const result = await streamToTelegram(123, events, tg as any, defaultConfig);
    expect(result.newSessionId).toBe("s2");
  });

  it("should show 'No response generated' for empty stream", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "done", sessionId: "s1" },
    ]);

    await streamToTelegram(123, events, tg as any, defaultConfig);

    const allEdited = tg.edited.map((e) => e.text).join(" ");
    expect(allEdited).toContain("No response generated");
  });

  it("should show thinking when showThinking=true", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "thinking", content: "Let me think..." },
      { type: "text", content: "Answer" },
      { type: "done", sessionId: "s1" },
    ]);

    await streamToTelegram(123, events, tg as any, { showToolCalls: false, showThinking: true });

    const allEdited = tg.edited.map((e) => e.text).join(" ");
    expect(allEdited).toContain("Let me think");
  });

  it("should handle account_retry events", async () => {
    await loadModule();
    const tg = makeMockTelegram();
    const events = makeEvents([
      { type: "account_retry", reason: "rate limit" },
      { type: "text", content: "OK" },
      { type: "done", sessionId: "s1" },
    ]);

    await streamToTelegram(123, events, tg as any, defaultConfig);

    const allEdited = tg.edited.map((e) => e.text).join(" ");
    expect(allEdited).toContain("rate limit");
  });
});
