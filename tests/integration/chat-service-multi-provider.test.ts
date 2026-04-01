import { describe, test, expect } from "bun:test";
import { chatService } from "../../src/services/chat.service.ts";

describe("ChatService multi-provider", () => {
  test("creates session with mock provider", async () => {
    const session = await chatService.createSession("mock", { title: "Multi Test" });
    expect(session.providerId).toBe("mock");
    expect(session.title).toBe("Multi Test");
  });

  test("listSessions aggregates from all providers", async () => {
    // Create sessions in mock provider
    await chatService.createSession("mock", { title: "Agg A" });
    await chatService.createSession("mock", { title: "Agg B" });

    const all = await chatService.listSessions();
    const mockSessions = all.filter((s) => s.providerId === "mock");
    expect(mockSessions.length).toBeGreaterThanOrEqual(2);
  });

  test("listSessions filtered by provider", async () => {
    await chatService.createSession("mock", { title: "Filtered" });
    const sessions = await chatService.listSessions("mock");
    expect(sessions.every((s) => s.providerId === "mock")).toBe(true);
  });

  test("getMessages returns empty for provider without getMessages", async () => {
    // "nonexistent" provider → empty
    const messages = await chatService.getMessages("nonexistent", "fake-session");
    expect(messages).toEqual([]);
  });

  test("getMessages works via optional chaining for mock provider", async () => {
    const session = await chatService.createSession("mock", {});
    // Send a message to populate history
    for await (const _ of chatService.sendMessage("mock", session.id, "test msg")) {
      // consume
    }
    const messages = await chatService.getMessages("mock", session.id);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe("user");
  });

  test("sendMessage yields error for unknown provider", async () => {
    const events: any[] = [];
    for await (const event of chatService.sendMessage("unknown-provider", "id", "hello")) {
      events.push(event);
    }
    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("not found");
  });

  test("getSession finds session across providers", async () => {
    const session = await chatService.createSession("mock", { title: "Findable Multi" });
    const found = chatService.getSession(session.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(session.id);
  });
});
