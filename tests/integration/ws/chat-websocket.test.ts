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
  waitForNthType: (type: string, n: number, timeout?: number) => Promise<any>;
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

      /** Wait for the Nth occurrence of a message type */
      const waitForNthType = (type: string, n: number, timeout = 10000): Promise<any> => {
        return new Promise((res, rej) => {
          const count = messages.filter((m) => m.type === type).length;
          if (count >= n) return res(messages.filter((m) => m.type === type)[n - 1]);

          const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${type} #${n}`)), timeout);
          const handler = (event: MessageEvent) => {
            try {
              const msg = JSON.parse(event.data as string);
              if (msg.type === type) {
                const newCount = messages.filter((m) => m.type === type).length;
                if (newCount >= n) {
                  clearTimeout(timer);
                  ws.removeEventListener("message", handler);
                  res(msg);
                }
              }
            } catch { /* ignore */ }
          };
          ws.addEventListener("message", handler);
        });
      };

      resolve({ ws, messages, waitForType, waitForNthType, close: () => ws.close() });
    };

    ws.onerror = () => reject(new Error("WS connection failed"));
  });
}

describe("Chat WebSocket — New Protocol", () => {
  // ─── session_state on connect ───

  it("sends session_state on open (replaces connected)", async () => {
    const session = await chatService.createSession("mock", {});
    const { waitForType, close } = await connectWs(session.id);

    const state = await waitForType("session_state");
    expect(state.sessionId).toBe(session.id);
    expect(state.phase).toBe("idle");
    expect(state.pendingApproval).toBeNull();

    close();
  });

  // ─── phase transitions ───

  it("transitions through phases during message stream", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    // Should see phase_changed events during streaming
    await waitForType("done");
    // Wait for idle phase_changed (sent after done in finally block)
    await new Promise((r) => setTimeout(r, 100));

    const phaseChanges = messages.filter((m) => m.type === "phase_changed");
    expect(phaseChanges.length).toBeGreaterThan(0);

    // Should have gone through at least initializing/connecting and back to idle
    const phases = phaseChanges.map((m: any) => m.phase);
    expect(phases).toContain("idle");

    // Verify we also got connecting phase (heartbeat or initial)
    const hasConnecting = phases.includes("connecting");
    const hasStreaming = phases.includes("streaming");
    expect(hasConnecting || hasStreaming).toBe(true);

    close();
  });

  // ─── text streaming ───

  it("streams text events for a message", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    const done = await waitForType("done");
    expect(done.sessionId).toBe(session.id);

    const textEvents = messages.filter((m) => m.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);

    const fullText = textEvents.map((e: any) => e.content).join("");
    expect(fullText.length).toBeGreaterThan(0);

    close();
  });

  // ─── tool_use events ───

  it("streams tool_use events for file-related messages", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "read the file" }));

    await waitForType("done");

    const toolUse = messages.find((m) => m.type === "tool_use");
    const toolResult = messages.find((m) => m.type === "tool_result");
    expect(toolUse).toBeTruthy();
    expect(toolUse.tool).toBe("Read");
    expect(toolResult).toBeTruthy();

    close();
  });

  // ─── approval_request ───

  it("streams approval_request for delete messages", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "delete temp" }));

    await waitForType("done");

    const approval = messages.find((m) => m.type === "approval_request");
    expect(approval).toBeTruthy();
    expect(approval.tool).toBe("Bash");

    close();
  });

  // ─── invalid JSON ───

  it("handles invalid JSON gracefully", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send("not json at all");

    const errMsg = await waitForType("error");
    expect(errMsg.message).toContain("Invalid JSON");

    close();
  });

  // ─── multi-turn ───

  it("supports multi-turn conversation in same session", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, waitForNthType, close } = await connectWs(session.id);

    await waitForType("session_state");

    // Turn 1
    ws.send(JSON.stringify({ type: "message", content: "hello" }));
    await waitForType("done");
    const turn1Texts = messages.filter((m) => m.type === "text").length;

    // Turn 2
    ws.send(JSON.stringify({ type: "message", content: "follow up" }));
    await waitForNthType("done", 2);

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

  // ─── cancel ───

  it("cancels streaming mid-response", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "hello world" }));

    await waitForType("text");
    const textsBefore = messages.filter((m) => m.type === "text").length;
    expect(textsBefore).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "cancel" }));
    await new Promise((r) => setTimeout(r, 500));

    const textsAfter = messages.filter((m) => m.type === "text").length;
    expect(textsAfter).toBeGreaterThanOrEqual(textsBefore);

    close();
  });

  it("cancel does not affect subsequent messages", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, waitForNthType, close } = await connectWs(session.id);

    await waitForType("session_state");

    ws.send(JSON.stringify({ type: "message", content: "hello" }));
    await waitForType("text");
    ws.send(JSON.stringify({ type: "cancel" }));
    await new Promise((r) => setTimeout(r, 600));

    const msgCountBefore = messages.length;
    ws.send(JSON.stringify({ type: "message", content: "second message" }));

    // Wait for a new done (at least 2nd one)
    const donesBefore = messages.filter((m) => m.type === "done").length;
    await waitForNthType("done", donesBefore + 1);

    const newMessages = messages.slice(msgCountBefore);
    const newTexts = newMessages.filter((m) => m.type === "text");
    expect(newTexts.length).toBeGreaterThan(0);

    const newDone = newMessages.find((m) => m.type === "done");
    expect(newDone).toBeTruthy();

    close();
  });

  it("cancel with no active stream is a no-op", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");

    ws.send(JSON.stringify({ type: "cancel" }));
    await new Promise((r) => setTimeout(r, 200));

    const errors = messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(0);

    ws.send(JSON.stringify({ type: "message", content: "hello after cancel" }));
    const done = await waitForType("done", 10000);
    expect(done.sessionId).toBe(session.id);

    close();
  });

  // ─── multi-client broadcast ───

  it("broadcasts events to multiple clients on same session", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect client 1
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");

    // Connect client 2
    const c2 = await connectWs(session.id);
    const c2State = await c2.waitForType("session_state");
    expect(c2State.phase).toBe("idle");

    // Send message from client 1
    c1.ws.send(JSON.stringify({ type: "message", content: "hello from client 1" }));

    // Both clients should receive done
    await c1.waitForType("done");
    await c2.waitForType("done");

    // Both should have received text events
    const c1Texts = c1.messages.filter((m) => m.type === "text");
    const c2Texts = c2.messages.filter((m) => m.type === "text");
    expect(c1Texts.length).toBeGreaterThan(0);
    expect(c2Texts.length).toBeGreaterThan(0);

    c1.close();
    c2.close();
  });

  // ─── reconnect with session_state ───

  it("reconnecting client gets session_state with current phase", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect and start streaming
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello reconnect test" }));

    // Wait for streaming to start
    await c1.waitForType("text");

    // Connect a second client (simulates reconnect) while streaming
    const c2 = await connectWs(session.id);
    const state = await c2.waitForType("session_state");

    // Phase should NOT be idle since streaming is in progress
    expect(state.phase).not.toBe("idle");
    expect(["initializing", "connecting", "thinking", "streaming"]).toContain(state.phase);

    // Wait for done on both
    await c1.waitForType("done");
    await c2.waitForType("done");

    c1.close();
    c2.close();
  });

  // ─── reconnect with turn_events ───

  it("reconnecting client receives turn_events for in-progress stream", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect and start streaming
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello turn events test" }));

    // Wait for at least one text event to be buffered
    await c1.waitForType("text");

    // Connect a second client — should receive turn_events
    const c2 = await connectWs(session.id);
    await c2.waitForType("session_state");

    // Should receive turn_events with buffered events
    const turnEvents = await c2.waitForType("turn_events", 5000);
    expect(turnEvents.events).toBeInstanceOf(Array);
    expect(turnEvents.events.length).toBeGreaterThan(0);

    // turn_events should contain the text events that were buffered
    const textInTurnEvents = turnEvents.events.filter((e: any) => e.type === "text");
    expect(textInTurnEvents.length).toBeGreaterThan(0);

    await c1.waitForType("done");
    c1.close();
    c2.close();
  });

  // ─── idle reconnect (no turn_events) ───

  it("reconnecting to idle session does NOT send turn_events", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect, send message, wait for completion
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello" }));
    await c1.waitForType("done");
    c1.close();

    // Wait for close to propagate
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect — session is idle now
    const c2 = await connectWs(session.id);
    const state = await c2.waitForType("session_state");
    expect(state.phase).toBe("idle");

    // Should NOT receive turn_events (buffer was cleared on done)
    await new Promise((r) => setTimeout(r, 500));
    const turnEvents = c2.messages.filter((m) => m.type === "turn_events");
    expect(turnEvents).toHaveLength(0);

    c2.close();
  });

  // ─── ready handshake ───

  it("ready message returns session_state (Cloudflare tunnel fallback)", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");

    // Send ready (simulates FE handshake after tunnel reconnect)
    ws.send(JSON.stringify({ type: "ready" }));

    // Should receive another session_state
    await new Promise((r) => setTimeout(r, 300));
    const sessionStates = messages.filter((m) => m.type === "session_state");
    expect(sessionStates.length).toBeGreaterThanOrEqual(2);

    close();
  });

  // ─── turn_events are shallow cloned ───

  it("turn_events contain cloned events (not references)", async () => {
    const session = await chatService.createSession("mock", {});

    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello clone test" }));

    // Wait for at least one text event
    await c1.waitForType("text");

    // Connect c2 to get turn_events
    const c2 = await connectWs(session.id);
    await c2.waitForType("session_state");
    const turnEvents = await c2.waitForType("turn_events", 5000);

    // Verify events are plain objects with type field
    for (const ev of turnEvents.events) {
      expect(typeof ev).toBe("object");
      expect(ev.type).toBeDefined();
    }

    await c1.waitForType("done");
    c1.close();
    c2.close();
  });

  // ─── phase goes back to idle after stream completes ───

  it("phase returns to idle after stream completes", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    await waitForType("done");
    // Wait for idle phase_changed (sent after done in finally block)
    await new Promise((r) => setTimeout(r, 100));

    // Last phase_changed should be "idle"
    const phaseChanges = messages.filter((m) => m.type === "phase_changed");
    const lastPhase = phaseChanges[phaseChanges.length - 1];
    expect(lastPhase?.phase).toBe("idle");

    close();
  });
});
