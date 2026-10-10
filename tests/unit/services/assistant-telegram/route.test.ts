import { describe, expect, it } from "bun:test";
import { connectChat, freshChat } from "./bridge-test-kit.ts";
import { assistantSettingsRoutes } from "../../../../src/server/routes/assistant-settings.ts";
import { getDb, setSessionAssistant, setSessionProvider, setSessionTitle } from "../../../../src/services/db.service.ts";

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

  it("refuses a chat that is not connected, a missing session and a chat it cannot pick", async () => {
    const session = assistantSession("Other");
    expect((await post({ sessionId: session, chatId: String(freshChat()) })).status).toBe(400);
    expect((await post({ chatId: "1" })).status).toBe(400);
    expect((await post({ sessionId: "plain-session" , chatId: connectChat(freshChat()) })).status).toBe(404);
    // Two connected chats now: which one is not guessed.
    expect((await post({ sessionId: session })).status).toBe(400);
  });
});
