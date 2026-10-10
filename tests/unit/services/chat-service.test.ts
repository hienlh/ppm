import { describe, it, expect, spyOn } from "bun:test";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import type { AIProvider, ChatEvent } from "../../../src/types/chat.ts";

describe("ChatService", () => {
  it("creates session with default provider", async () => {
    const session = await chatService.createSession(undefined, {
      title: "Test",
    });

    expect(session.id).toBeTruthy();
    expect(session.providerId).toBe("claude"); // default provider
    expect(session.title).toBe("Test");
  });

  it("creates session with specific provider", async () => {
    const session = await chatService.createSession("mock", {
      title: "Mock Chat",
    });

    expect(session.providerId).toBe("mock");
    expect(session.title).toBe("Mock Chat");
  });

  it("throws on unknown provider", async () => {
    expect(
      chatService.createSession("nonexistent", {}),
    ).rejects.toThrow('Provider "nonexistent" not found');
  });

  it("lists sessions from all providers", async () => {
    // Create sessions in mock provider
    await chatService.createSession("mock", { title: "A" });
    await chatService.createSession("mock", { title: "B" });

    const all = await chatService.listSessions();
    // Should include at least the mock sessions
    const mockSessions = all.filter((s) => s.providerId === "mock");
    expect(mockSessions.length).toBeGreaterThanOrEqual(2);
  });

  it("lists sessions filtered by provider", async () => {
    await chatService.createSession("mock", { title: "Filtered" });
    const sessions = await chatService.listSessions("mock");

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((s) => s.providerId === "mock")).toBe(true);
  });

  it("deletes session", async () => {
    const session = await chatService.createSession("mock", { title: "Delete me" });
    await chatService.deleteSession("mock", session.id);

    const sessions = await chatService.listSessions("mock");
    expect(sessions.find((s) => s.id === session.id)).toBeUndefined();
  });

  it("streams events from sendMessage", async () => {
    const session = await chatService.createSession("mock", {});
    const events: any[] = [];

    for await (const event of chatService.sendMessage("mock", session.id, "hello world")) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("returns error for unknown provider in sendMessage", async () => {
    const events: any[] = [];

    for await (const event of chatService.sendMessage("bad-provider", "id", "hello")) {
      events.push(event);
    }

    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("not found");
  });

  it("getSession finds session across providers", async () => {
    const session = await chatService.createSession("mock", { title: "Findable" });
    const found = chatService.getSession(session.id);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(session.id);
  });

  it("getMessages returns history for mock provider", async () => {
    const session = await chatService.createSession("mock", {});

    for await (const _ of chatService.sendMessage("mock", session.id, "test msg")) {
      // consume
    }

    const messages = await chatService.getMessages("mock", session.id);
    expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("test msg");
  });

  it("logs each turn's start and end, without the message, and an abort as its result", async () => {
    const info = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const lines = (spy: typeof info) => spy.mock.calls
      .map((c) => String(c[0]).replace(/ durationMs=\d+/, ""))
      .filter((l) => l.startsWith("[chat] "));
    try {
      const session = await chatService.createSession("mock", {});
      let aborted = false;
      for await (const event of chatService.sendMessage("mock", session.id, "a secret prompt", { origin: "ws" })) {
        if (event.type === "text" && !aborted) {
          aborted = true;
          chatService.abortQuery("mock", session.id, "ws_cancel", "ws");
        }
      }
      // Nothing is running any more: tearing down an idle subprocess is not a turn's news.
      chatService.abortQuery("mock", session.id, "set_model", "ws");
      expect(lines(info)).toEqual([
        `[chat] turn start session=${session.id} provider=mock origin=ws stream=new model=default images=0`,
        `[chat] session=${session.id} abort reason=ws_cancel origin=ws`,
        `[chat] turn end session=${session.id} provider=mock origin=ws result=aborted reason=ws_cancel`,
      ]);
      expect(info.mock.calls.some((c) => c.map(String).join(" ").includes("a secret prompt"))).toBe(false);

      info.mockClear();
      for await (const _ of chatService.sendMessage("no-such-provider", "s1", "hi", { origin: "scheduler" })) {
        // consume
      }
      expect(lines(info)).toEqual([
        "[chat] turn start session=s1 provider=no-such-provider origin=scheduler stream=new model=default images=0",
      ]);
      expect(lines(error)).toEqual([
        '[chat] turn end session=s1 provider=no-such-provider origin=scheduler result=error error="Provider \\"no-such-provider\\" not found"',
      ]);
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  it("names each turn of a live stream by the origin that started that turn", async () => {
    // One stream that runs three turns: its own, then one per follow-up. A follow-up into a live
    // stream is folded into it (pushed, or sent while the stream is running), the way Claude and
    // Codex take them.
    let queued = 0;
    let waiter: (() => void) | null = null;
    let liveStream = false;
    // A follow-up may arrive before the stream waits for it (it is sent while the stream is
    // suspended on its `done`), so they are counted rather than signalled.
    const followUp = () => { queued++; waiter?.(); };
    const nextFollowUp = async () => {
      while (queued === 0) await new Promise<void>((resolve) => { waiter = resolve; });
      queued--;
      waiter = null;
    };
    const provider: AIProvider & { pushMessage(id: string, content: string): void } = {
      id: "live-origin-test",
      name: "Live origin test",
      createSession: async () => ({ id: "unused", providerId: "live-origin-test", title: "", createdAt: "" }),
      resumeSession: async (id) => ({ id, providerId: "live-origin-test", title: "", createdAt: "" }),
      listSessions: async () => [],
      deleteSession: async () => {},
      pushMessage: () => { followUp(); },
      async *sendMessage(sessionId) {
        if (liveStream) { followUp(); return; }
        liveStream = true;
        for (let i = 0; i < 3; i++) {
          if (i > 0) await nextFollowUp();
          yield { type: "text", content: `turn ${i}` } as ChatEvent;
          yield { type: "done", sessionId } as ChatEvent;
        }
        liveStream = false;
      },
    };
    providerRegistry.register(provider);
    const info = spyOn(console, "log").mockImplementation(() => {});
    try {
      const sid = "live-origin-session";
      let done = 0;
      for await (const event of chatService.sendMessage(provider.id, sid, "first", { origin: "telegram" })) {
        if (event.type !== "done") continue;
        done++;
        if (done === 1) await chatService.pushMessage(provider.id, sid, "second", { origin: "watch" });
        if (done === 2) for await (const _ of chatService.sendMessage(provider.id, sid, "third", { origin: "assistant" })) { /* folded in */ }
      }
      const ends = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[chat] turn end"))
        .map((l) => /origin=(\S+)/.exec(l)?.[1]);
      expect(ends).toEqual(["telegram", "watch", "assistant"]);
    } finally {
      info.mockRestore();
    }
  });
});
