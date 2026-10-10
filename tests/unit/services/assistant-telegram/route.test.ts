import { describe, expect, it } from "bun:test";
import { connectChat, freshChat } from "./bridge-test-kit.ts";
import { assistantSettingsRoutes } from "../../../../src/server/routes/assistant-settings.ts";
import { getDb, setSessionAssistant, setSessionProvider, setSessionTitle } from "../../../../src/services/db.service.ts";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import type { AIProvider } from "../../../../src/types/chat.ts";

/** A provider whose session titles come from its own listing, as Codex's do. */
const TITLED = "stub-titled-sessions";
const derived = new Map<string, string>();
providerRegistry.register({
  id: TITLED, name: "Titled", supportsAssistantSessions: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: TITLED, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: TITLED, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async listSessionsByDir() {
    return [...derived].map(([id, title]) => ({ id, providerId: TITLED, title, createdAt: "2026-10-11T00:00:00Z" }));
  },
  async deleteSession() {},
  async *sendMessage() {},
} as AIProvider);

const post = (body: unknown) => assistantSettingsRoutes.request("/telegram/bind", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function assistantSession(title: string): string {
  const id = `route-${crypto.randomUUID()}`;
  setSessionAssistant(id);
  setSessionProvider(id, "claude");
  setSessionTitle(id, title);
  return id;
}

describe("/api/assistant/telegram", () => {
  it("binds a session to the one connected chat, and lists it", async () => {
    getDb().query("DELETE FROM clawbot_paired_chats").run();
    const chat = connectChat(freshChat());
    const session = assistantSession("Daily check");
    const res = await post({ sessionId: session });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ chatId: chat, sessionId: session, providerId: "claude" });

    const list = await (await assistantSettingsRoutes.request("/telegram")).json();
    expect(list.data).toMatchObject({ enabled: false, running: false, chats: [{ chatId: chat, sessionId: session, sessionTitle: "Daily check" }] });
  });

  it("names a bound session that was never renamed by the title its provider derives", async () => {
    getDb().query("DELETE FROM clawbot_paired_chats").run();
    const chat = connectChat(freshChat());
    const id = `route-${crypto.randomUUID()}`;
    setSessionAssistant(id);
    setSessionProvider(id, TITLED);
    derived.set(id, "Why did the nightly build fail?");
    expect((await post({ sessionId: id })).status).toBe(200);
    const list = await (await assistantSettingsRoutes.request("/telegram")).json();
    expect(list.data.chats).toEqual([{ chatId: chat, name: `User${chat}`, sessionId: id, sessionTitle: "Why did the nightly build fail?" }]);
    // A rename still wins.
    setSessionTitle(id, "Nightly");
    expect((await (await assistantSettingsRoutes.request("/telegram")).json()).data.chats[0].sessionTitle).toBe("Nightly");
  });

  it("refuses a chat that is not connected, a missing session and a chat it cannot pick", async () => {
    const session = assistantSession("Other");
    expect((await post({ sessionId: session, chatId: String(freshChat()) })).status).toBe(400);
    expect((await post({ chatId: "1" })).status).toBe(400);
    expect((await post({ sessionId: "plain-session" , chatId: connectChat(freshChat()) })).status).toBe(404);
    // Two connected chats now: which one is not guessed.
    expect((await post({ sessionId: session })).status).toBe(400);
  });
});
