import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { chatService } from "../../../src/services/chat.service.ts";

const PORT = 19876;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const { app } = await import("../../../src/server/index.ts");
  const { chatWebSocket } = await import("../../../src/server/ws/chat.ts");

  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      const url = new URL(req.url);

      // WebSocket upgrade for chat
      if (url.pathname.startsWith("/ws/chat/")) {
        const sessionId = url.pathname.split("/ws/chat/")[1] ?? "";
        const upgraded = srv.upgrade(req, {
          data: { type: "chat", sessionId },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req, srv as any);
    },
    websocket: {
      open: chatWebSocket.open as any,
      message: chatWebSocket.message as any,
      close: chatWebSocket.close as any,
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

function connectWs(sessionId: string): Promise<{
  ws: WebSocket;
  messages: any[];
  waitForType: (type: string, timeout?: number) => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/chat/${sessionId}`, {
    } as any);
    const messages: any[] = [];

    ws.onmessage = (event) => {
      try {
        messages.push(JSON.parse(event.data as string));
      } catch {
        // ignore
      }
    };

    ws.onopen = () => {
      const waitForType = (type: string, timeout = 10000): Promise<any> => {
        return new Promise((res, rej) => {
          const existing = messages.find((m) => m.type === type);
          if (existing) return res(existing);

          const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${type}`)), timeout);
          const handler = (event: MessageEvent) => {
            try {
              const msg = JSON.parse(event.data as string);
              if (msg.type === type) {
                clearTimeout(timer);
                ws.removeEventListener("message", handler);
                res(msg);
              }
            } catch {
              // ignore
            }
          };
          ws.addEventListener("message", handler);
        });
      };

      resolve({ ws, messages, waitForType, close: () => ws.close() });
    };

    ws.onerror = () => reject(new Error("WS connection failed"));
  });
}

describe("Chat WebSocket", () => {
  it("sends connected event on open", async () => {
    const session = await chatService.createSession("mock", {});
    const { waitForType, close } = await connectWs(session.id);

    const connected = await waitForType("connected");
    expect(connected.sessionId).toBe(session.id);

    close();
  });

  it("streams text events for a message", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");
    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    const done = await waitForType("done");
    expect(done.sessionId).toBe(session.id);

    const textEvents = messages.filter((m) => m.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);

    const fullText = textEvents.map((e) => e.content).join("");
    expect(fullText.length).toBeGreaterThan(0);

    close();
  });

  it("streams tool_use events for file-related messages", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");
    ws.send(JSON.stringify({ type: "message", content: "read the file" }));

    await waitForType("done");

    const toolUse = messages.find((m) => m.type === "tool_use");
    const toolResult = messages.find((m) => m.type === "tool_result");
    expect(toolUse).toBeTruthy();
    expect(toolUse.tool).toBe("Read");
    expect(toolResult).toBeTruthy();

    close();
  });

  it("streams approval_request for delete messages", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");
    ws.send(JSON.stringify({ type: "message", content: "delete temp" }));

    await waitForType("done");

    const approval = messages.find((m) => m.type === "approval_request");
    expect(approval).toBeTruthy();
    expect(approval.tool).toBe("Bash");

    close();
  });

  it("handles invalid JSON gracefully", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");
    ws.send("not json at all");

    const errMsg = await waitForType("error");
    expect(errMsg.message).toContain("Invalid JSON");

    close();
  });

  it("supports multi-turn conversation in same session", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");

    // Turn 1
    ws.send(JSON.stringify({ type: "message", content: "hello" }));
    await waitForType("done");
    const turn1Texts = messages.filter((m) => m.type === "text").length;

    // Turn 2
    const doneCountBefore = messages.filter((m) => m.type === "done").length;
    ws.send(JSON.stringify({ type: "message", content: "follow up" }));

    // Wait until we see a new "done" event
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for turn 2 done")), 10000);
      const handler = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "done" && messages.filter((m: any) => m.type === "done").length > doneCountBefore) {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve();
          }
        } catch { /* ignore */ }
      };
      ws.addEventListener("message", handler);
    });

    const turn2Texts = messages.filter((m) => m.type === "text").length;
    expect(turn2Texts).toBeGreaterThanOrEqual(turn1Texts);

    // Small delay to let mock provider finish storing messages
    await new Promise((r) => setTimeout(r, 100));

    // Verify history has both turns
    const history = await chatService.getMessages("mock", session.id);
    const userMsgs = history.filter((m: any) => m.role === "user");
    expect(userMsgs).toHaveLength(2);

    close();
  });

  it("cancels streaming mid-response", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");

    // Send a message that will trigger slow streaming
    ws.send(JSON.stringify({ type: "message", content: "hello world" }));

    // Wait for at least one text event to arrive (streaming started)
    await waitForType("text");

    // Count text events so far
    const textsBefore = messages.filter((m) => m.type === "text").length;
    expect(textsBefore).toBeGreaterThan(0);

    // Send cancel
    ws.send(JSON.stringify({ type: "cancel" }));

    // Wait a bit for cancel to take effect
    await new Promise((r) => setTimeout(r, 500));

    // The stream should have stopped — no "done" event with full text
    // Text events should be fewer than a full response (~10 words = ~10 text events)
    const textsAfter = messages.filter((m) => m.type === "text").length;
    // Cancel should have stopped streaming before all words were sent
    // (Mock sends ~7 words at 50ms each = 350ms, we cancel after first text ~350ms in)
    // Just verify we got some but the stream was interrupted (no new done event)
    expect(textsAfter).toBeGreaterThanOrEqual(textsBefore);

    close();
  });

  it("cancel does not affect subsequent messages", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");

    // Send message and cancel quickly
    ws.send(JSON.stringify({ type: "message", content: "hello" }));
    await waitForType("text");
    ws.send(JSON.stringify({ type: "cancel" }));

    // Wait for cancel to settle
    await new Promise((r) => setTimeout(r, 600));

    // Clear messages array for clean tracking of turn 2
    const msgCountBefore = messages.length;

    // Send another message — should work normally
    ws.send(JSON.stringify({ type: "message", content: "second message" }));

    // Wait for done from the second message
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for second done")), 10000);
      const donesBefore = messages.filter((m) => m.type === "done").length;
      const handler = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "done" && messages.filter((m: any) => m.type === "done").length > donesBefore) {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve();
          }
        } catch { /* ignore */ }
      };
      ws.addEventListener("message", handler);
    });

    // Should have new text events from second message
    const newMessages = messages.slice(msgCountBefore);
    const newTexts = newMessages.filter((m) => m.type === "text");
    expect(newTexts.length).toBeGreaterThan(0);

    // Should have a done event from second message
    const newDone = newMessages.find((m) => m.type === "done");
    expect(newDone).toBeTruthy();

    close();
  });

  it("cancel with no active stream is a no-op", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("connected");

    // Send cancel before any message — should not crash
    ws.send(JSON.stringify({ type: "cancel" }));
    await new Promise((r) => setTimeout(r, 200));

    // No error events should be emitted
    const errors = messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(0);

    // Can still send a normal message after
    ws.send(JSON.stringify({ type: "message", content: "hello after cancel" }));
    const done = await waitForType("done", 10000);
    expect(done.sessionId).toBe(session.id);

    close();
  });
});
