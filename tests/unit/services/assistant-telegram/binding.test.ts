import { afterAll, describe, expect, it } from "bun:test";
import { connectChat, disconnectChat, freshChat } from "./bridge-test-kit.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { deleteSessionMetadata, setSessionAssistant, setSessionProvider } from "../../../../src/services/db.service.ts";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import { getTelegramBinding } from "../../../../src/services/assistant-hub/assistant-hub-db.ts";
import {
  announceAfterFirstTurn, assistantProviderFor, BindingError, bindChat, boundSession, ensureBoundSession, startNewSession, unbindChat,
} from "../../../../src/services/assistant-telegram/assistant-telegram-binding.ts";
import { createChatLifecycle } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import type { AIProvider } from "../../../../src/types/chat.ts";

const STUB = "stub-telegram-binding";
providerRegistry.register({
  id: STUB, name: "Stub", supportsAssistantSessions: true,
  async createSession() { return { id: `tg-${crypto.randomUUID()}`, providerId: STUB, title: "", createdAt: new Date().toISOString() }; },
  async resumeSession(id: string) { return { id, providerId: STUB, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage() {},
} as AIProvider);

const original = configService.get("assistant");
afterAll(() => configService.set("assistant", original));

function assistantSession(provider = STUB): string {
  const id = `asst-${crypto.randomUUID()}`;
  setSessionAssistant(id);
  setSessionProvider(id, provider);
  return id;
}

describe("binding a Telegram chat to an Assistant session", () => {
  it("binds a connected chat, and refuses one that is not connected", () => {
    const chat = connectChat(freshChat());
    const session = assistantSession();
    expect(bindChat(chat, session)).toMatchObject({ telegramChatId: chat, sessionId: session, providerId: STUB });
    expect(() => bindChat(String(freshChat()), session)).toThrow(BindingError);
  });

  it("refuses a session that is not an Assistant session", () => {
    const chat = connectChat(freshChat());
    const ordinary = `plain-${crypto.randomUUID()}`;
    setSessionProvider(ordinary, STUB);
    expect(() => bindChat(chat, ordinary)).toThrow("Not a PPM Assistant session");
  });

  it("starts a new session when the bound one is gone", async () => {
    configService.set("assistant", { ...original, default_provider: STUB });
    const chat = connectChat(freshChat());
    const first = await ensureBoundSession(chat);
    expect(first.providerId).toBe(STUB);
    expect((await ensureBoundSession(chat)).sessionId).toBe(first.sessionId);
    deleteSessionMetadata(first.sessionId);
    expect(boundSession(chat)).toBeNull();
    const second = await ensureBoundSession(chat);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(getTelegramBinding(chat)?.sessionId).toBe(second.sessionId);
  });

  it("falls back to a provider that can run the Assistant when the default cannot", () => {
    configService.set("assistant", { ...original, default_provider: "mock" });
    const picked = assistantProviderFor();
    expect(providerRegistry.get(picked)?.supportsAssistantSessions).toBe(true);
    expect(() => assistantProviderFor("mock")).toThrow(BindingError);
    expect(assistantProviderFor(STUB)).toBe(STUB);
  });

  it("announces the session list again once a new session's first turn ends, under its new id if renamed", () => {
    const lifecycle = createChatLifecycle();
    const sent: unknown[] = [];
    announceAfterFirstTurn("draft-1", { lifecycle, broadcast: (e) => sent.push(e) });
    const end = (sessionId: string) => lifecycle.emit("turn_ended", { sessionId, outcome: "done", projectName: "__assistant__", providerId: STUB });
    end("someone-else");
    expect(sent).toEqual([]);
    lifecycle.emit("migrated", { oldSessionId: "draft-1", newSessionId: "thread-1" });
    end("thread-1");
    expect(sent).toEqual([{ type: "sessions:list_changed", projectName: "__assistant__" }]);
    // Once: later turns do not announce again.
    end("thread-1");
    expect(sent).toHaveLength(1);
    expect(lifecycle.has("turn_ended")).toBe(false);
  });

  it("stops waiting for a first turn that never comes", async () => {
    const lifecycle = createChatLifecycle();
    announceAfterFirstTurn("never", { lifecycle, broadcast: () => {}, waitMs: 5 });
    expect(lifecycle.has("turn_ended")).toBe(true);
    await Bun.sleep(20);
    expect(lifecycle.has("turn_ended")).toBe(false);
    expect(lifecycle.has("migrated")).toBe(false);
  });

  it("starts no session for a chat that is not connected, and forgets an unbound chat", async () => {
    const id = freshChat();
    const chat = connectChat(id);
    await startNewSession(chat, STUB);
    disconnectChat(id);
    await expect(startNewSession(chat, STUB)).rejects.toThrow(BindingError);
    expect(unbindChat(chat)).toBe(true);
    expect(unbindChat(chat)).toBe(false);
  });
});
