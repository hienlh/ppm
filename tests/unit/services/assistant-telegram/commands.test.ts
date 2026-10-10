import { describe, expect, it } from "bun:test";
import { connectChat, freshChat } from "./bridge-test-kit.ts";
import { BOT_COMMANDS, HELP_TEXT, parseCommand, runCommand } from "../../../../src/services/assistant-telegram/assistant-telegram-commands.ts";
import { boundSession } from "../../../../src/services/assistant-telegram/assistant-telegram-binding.ts";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import type { AIProvider } from "../../../../src/types/chat.ts";
import type { InlineKeyboardMarkup } from "../../../../src/services/telegram/telegram-types.ts";

const STUB = "stub-telegram-commands";
providerRegistry.register({
  id: STUB, name: "Stub", supportsAssistantSessions: true,
  async createSession() { return { id: `cmd-${crypto.randomUUID()}`, providerId: STUB, title: "", createdAt: new Date().toISOString() }; },
  async resumeSession(id: string) { return { id, providerId: STUB, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async listSessionsByDir() {
    return [
      { id: "old", providerId: STUB, title: "Yesterday's chat", createdAt: "2026-10-09T10:00:00Z" },
      { id: "new", providerId: STUB, title: "Today's chat", createdAt: "2026-10-10T10:00:00Z" },
    ];
  },
  async deleteSession() {},
  async *sendMessage() {},
} as AIProvider);

function context() {
  const chatId = connectChat(freshChat());
  const replies: Array<{ html: string; markup?: InlineKeyboardMarkup }> = [];
  const switched: string[] = [];
  return {
    chatId, replies, switched,
    ctx: {
      chatId,
      reply: (html: string, markup?: InlineKeyboardMarkup) => { replies.push({ html, ...(markup ? { markup } : {}) }); },
      switchCode: (sessionId: string) => { switched.push(sessionId); return `a:${sessionId}`; },
    },
  };
}

describe("the bot's commands", () => {
  it("reads a command with or without the bot's name, and nothing else", () => {
    expect(parseCommand("/new codex")).toEqual({ name: "new", args: "codex" });
    expect(parseCommand("/Sessions@ppm_bot")).toEqual({ name: "sessions", args: "" });
    expect(parseCommand("please /stop")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(BOT_COMMANDS.map((c) => c.command)).not.toContain("restart");
  });

  it("starts a new conversation on the provider asked for, and refuses one that cannot run it", async () => {
    const t = context();
    await runCommand({ name: "new", args: STUB }, t.ctx);
    expect(t.replies[0]!.html).toContain("New conversation on <b>Stub</b>");
    expect(boundSession(t.chatId)?.providerId).toBe(STUB);
    await runCommand({ name: "new", args: "mock" }, t.ctx);
    expect(t.replies[1]!.html).toContain("cannot run on");
  });

  it("lists conversations newest first with a button each", async () => {
    const t = context();
    await runCommand({ name: "sessions", args: "" }, t.ctx);
    const rows = t.replies[0]!.markup!.inline_keyboard.map((r) => r[0]!.text);
    expect(rows.indexOf("Today's chat · Stub")).toBeLessThan(rows.indexOf("Yesterday's chat · Stub"));
    expect(t.switched).toEqual(expect.arrayContaining(["new", "old"]));
  });

  it("says when there is nothing to stop, and answers /help and unknown commands", async () => {
    const t = context();
    await runCommand({ name: "stop", args: "" }, t.ctx);
    await runCommand({ name: "help", args: "" }, t.ctx);
    await runCommand({ name: "restart", args: "" }, t.ctx);
    expect(t.replies.map((r) => r.html)).toEqual(["Nothing is running.", HELP_TEXT, "Unknown command /restart. Send /help for the list."]);
  });
});
