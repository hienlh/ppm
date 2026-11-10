/**
 * The main Assistant session: a Claude Assistant session only; the first one created takes the
 * role; at the first start of an install that never had one, the session Telegram already talks
 * to wins over the most recently active one and a Codex session is never picked; deleting it
 * clears the role; changing it moves the Telegram chats that followed the old one, and only those;
 * an unbound Telegram chat binds to it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connectChat, freshChat } from "./assistant-telegram/bridge-test-kit.ts";
import { configService } from "../../../src/services/config.service.ts";
import { deleteSessionMetadata, setSessionAssistant, setSessionProvider } from "../../../src/services/db.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import {
  adoptAsMainIfNone, clearMainSessionIf, getMainSession, MainSessionError, pickMainSessionOnStartup, setMainSession,
} from "../../../src/services/assistant/assistant-main-session.ts";
import { ensureBoundSession, followMainSession } from "../../../src/services/assistant-telegram/assistant-telegram-binding.ts";
import { getTelegramBinding, setTelegramBinding } from "../../../src/services/assistant-hub/assistant-hub-db.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const STUB = "stub-main-session";
providerRegistry.register({
  id: STUB, name: "Stub", supportsAssistantSessions: true,
  async createSession() { return { id: `m-${crypto.randomUUID()}`, providerId: STUB, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: STUB, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage() {},
} as AIProvider);

const original = configService.get("assistant");
const { main_session: _none, ...withoutMain } = original ?? {};
beforeEach(() => configService.set("assistant", structuredClone(withoutMain) as never));
afterEach(() => configService.set("assistant", structuredClone(withoutMain) as never));
afterAll(() => configService.set("assistant", original));

function assistantSession(provider = "claude"): string {
  const id = `asst-${crypto.randomUUID()}`;
  setSessionAssistant(id);
  setSessionProvider(id, provider);
  return id;
}

const sources = (bound: string[], recent: string[]) => ({
  boundSessionIds: () => bound,
  recentAssistantSessionIds: async () => recent,
});

describe("which session may be main", () => {
  it("takes a Claude Assistant session only", () => {
    expect(() => setMainSession(assistantSession("codex"))).toThrow(MainSessionError);
    const plain = `plain-${crypto.randomUUID()}`;
    setSessionProvider(plain, "claude");
    expect(() => setMainSession(plain)).toThrow("Not a PPM Assistant session");
    const ok = assistantSession();
    expect(setMainSession(ok)).toEqual({ previous: null, current: ok });
    expect(getMainSession()).toEqual({ providerId: "claude", sessionId: ok });
  });

  it("makes the first Claude session main, and no later one", () => {
    expect(adoptAsMainIfNone(assistantSession("codex"), "codex")).toBe(false);
    const first = assistantSession();
    expect(adoptAsMainIfNone(first, "claude")).toBe(true);
    expect(adoptAsMainIfNone(assistantSession(), "claude")).toBe(false);
    expect(getMainSession()?.sessionId).toBe(first);
  });
});

describe("the pick at startup", () => {
  it("prefers the session a Telegram chat talks to over the most recently active, and never Codex", async () => {
    const codex = assistantSession("codex");
    const bound = assistantSession();
    const recent = assistantSession();
    expect(await pickMainSessionOnStartup(sources([codex, bound], [recent]))).toBe(bound);
    expect(getMainSession()?.sessionId).toBe(bound);
  });

  it("stops when a session took the role while the list was being read", async () => {
    const taken = assistantSession();
    const picked = await pickMainSessionOnStartup({
      boundSessionIds: () => [],
      recentAssistantSessionIds: async () => { setMainSession(taken); return [assistantSession()]; },
    });
    expect(picked).toBeNull();
    expect(getMainSession()?.sessionId).toBe(taken);
  });

  it("falls back to recency, and runs only on an install that never had a main", async () => {
    const recent = assistantSession();
    expect(await pickMainSessionOnStartup(sources([], [assistantSession("codex"), recent]))).toBe(recent);
    expect(await pickMainSessionOnStartup(sources([], [assistantSession()]))).toBeNull();
    clearMainSessionIf(recent);
    expect(getMainSession()).toBeNull();
    // Cleared by a delete: the next start leaves it so.
    expect(await pickMainSessionOnStartup(sources([], [assistantSession()]))).toBeNull();
  });
});

describe("deleting the main session", () => {
  it("clears the role through the chat service's delete", async () => {
    const main = assistantSession();
    setMainSession(main);
    await chatService.deleteSession(STUB, `other-${crypto.randomUUID()}`);
    expect(getMainSession()?.sessionId).toBe(main);
    await chatService.deleteSession(STUB, main);
    expect(configService.get("assistant")?.main_session).toBeNull();
  });
});

describe("Telegram and the main session", () => {
  it("binds an unbound chat to the main session", async () => {
    const main = assistantSession();
    setMainSession(main);
    const chat = connectChat(freshChat());
    expect((await ensureBoundSession(chat)).sessionId).toBe(main);
  });

  it("moves only the chats that followed the old main", () => {
    const oldMain = assistantSession();
    const oneOff = assistantSession();
    const next = assistantSession();
    const follower = connectChat(freshChat());
    const elsewhere = connectChat(freshChat());
    setTelegramBinding(follower, oldMain, "claude");
    setTelegramBinding(elsewhere, oneOff, "claude");
    expect(followMainSession(oldMain, next)).toEqual([follower]);
    expect(getTelegramBinding(follower)?.sessionId).toBe(next);
    expect(getTelegramBinding(elsewhere)?.sessionId).toBe(oneOff);
  });

  it("starts a new session for an unbound chat when no main is left", async () => {
    const main = assistantSession();
    setMainSession(main);
    deleteSessionMetadata(main);
    expect(getMainSession()).toBeNull();
    configService.set("assistant", { ...structuredClone(withoutMain), default_provider: STUB } as never);
    const chat = connectChat(freshChat());
    const bound = await ensureBoundSession(chat);
    expect(bound.sessionId).not.toBe(main);
    expect(bound.providerId).toBe(STUB);
  });
});
