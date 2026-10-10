import { encodeReply, decodeReply, type ReplyReference } from "../../../src/shared/chat-reply.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { chatService, TELEGRAM_CHANNEL_CONTEXT_ENTRY } from "../../../src/services/chat.service.ts";
import {
  getSessionEffort, getSessionThinking, getSessionModel, clearSessionUnread, getSessionUnreadCount,
  setSessionAssistant, setSessionProvider,
} from "../../../src/services/db.service.ts";
import { THINKING_ADAPTIVE } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { CHAT_BUSY, chatControl, type ChatControl } from "../../../src/services/chat-control/chat-control.ts";
import { chatLifecycle, type ChatLifecycleEvents } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { addNotificationSuppressor } from "../../../src/services/chat-control/notification-suppressor.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project.ts";
import type { AIProvider, SendMessageOpts } from "../../../src/types/chat.ts";

const PORT = 19879; // Unique port — avoid conflict with supervisor-resilience (19876)
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
        const sessionId = (url.pathname.split("/ws/chat/")[1] ?? "").split("?")[0] ?? "";
        // `?project=` lets a test attach a projectName, mirroring the real
        // /ws/project/:projectName/chat/:id upgrade.
        const projectName = url.searchParams.get("project") ?? undefined;
        const upgraded = srv.upgrade(req, {
          data: { type: "chat", sessionId, projectName },
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

function connectWs(sessionId: string, projectName?: string): Promise<{
  ws: WebSocket;
  messages: any[];
  waitForType: (type: string, timeout?: number) => Promise<any>;
  waitForNthType: (type: string, n: number, timeout?: number) => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const query = projectName ? `?project=${encodeURIComponent(projectName)}` : "";
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/chat/${sessionId}${query}`, {
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

  it("system events transition phase from connecting to thinking before first content", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    // Wait for "thinking" phase — should arrive BEFORE first text event
    // (system events from mock provider trigger connecting → thinking)
    await waitForType("done");
    await new Promise((r) => setTimeout(r, 100));

    const phaseChanges = messages.filter((m) => m.type === "phase_changed");
    const phases = phaseChanges.map((m: any) => m.phase);

    // Phase sequence should include: connecting → thinking → streaming → idle
    expect(phases).toContain("thinking");
    expect(phases).toContain("streaming");
    expect(phases).toContain("idle");

    // "thinking" must come BEFORE "streaming" in sequence
    const thinkingIdx = phases.indexOf("thinking");
    const streamingIdx = phases.indexOf("streaming");
    expect(thinkingIdx).toBeLessThan(streamingIdx);

    // system events must NOT be broadcast to clients (they're internal)
    const systemEvents = messages.filter((m) => m.type === "system");
    expect(systemEvents).toHaveLength(0);

    close();
  });

  it("keeps phase idle when a system event arrives after the turn ended", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, messages, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    // Mock emits a stray `system/commands_changed` ~100ms after `done`, mirroring
    // the live SDK subprocess that outlives the turn.
    ws.send(JSON.stringify({ type: "message", content: "trailing-system" }));

    await waitForType("done");
    await new Promise((r) => setTimeout(r, 500));

    // Nothing after `done` may move the session out of idle: no `done` would
    // follow to reset it, leaving the FE spinner stuck forever.
    const doneIdx = messages.findIndex((m) => m.type === "done");
    const afterDone = messages
      .slice(doneIdx + 1)
      .filter((m) => m.type === "phase_changed")
      .map((m: any) => m.phase);
    expect(afterDone.filter((p) => p !== "idle")).toEqual([]);

    // Same state the tab-strip seed endpoint reads
    const { listRunningSessions } = await import("../../../src/server/ws/chat.ts");
    expect(listRunningSessions().some((s) => s.sessionId === session.id)).toBe(false);

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

  it("echoes user_message to other clients but not the sender", async () => {
    const session = await chatService.createSession("mock", {});

    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    const c2 = await connectWs(session.id);
    await c2.waitForType("session_state");

    c1.ws.send(JSON.stringify({ type: "message", content: "hello from device A" }));

    // Second device gets the user message echo with the original content
    const echo = await c2.waitForType("user_message");
    expect(echo.content).toBe("hello from device A");

    await c1.waitForType("done");
    await c2.waitForType("done");

    // Sender rendered its message optimistically — no echo back to it
    expect(c1.messages.filter((m) => m.type === "user_message").length).toBe(0);

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

  it("replays an in-progress turn when a client requests stream resync", async () => {
    const session = await chatService.createSession("mock", {});
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello stream resync" }));

    const text = await c1.waitForType("text");
    expect(text.streamSeq).toBeGreaterThan(0);
    c1.ws.send(JSON.stringify({ type: "resync" }));

    const replay = await c1.waitForType("turn_events");
    expect(replay.events.some((event: any) => event.streamSeq === text.streamSeq)).toBe(true);

    await c1.waitForType("done");
    const stateCount = c1.messages.filter((message) => message.type === "session_state").length;
    c1.ws.send(JSON.stringify({ type: "resync" }));
    const idle = await c1.waitForNthType("session_state", stateCount + 1);
    expect(idle.phase).toBe("idle");
    c1.close();
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

  // ─── abort-and-replace from different client ───

  it("client 2 sending follow-up message pushes into active stream", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect client 1, start streaming
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello from client 1" }));

    // Wait for first turn to complete
    await c1.waitForType("done");

    // Connect client 2
    const c2 = await connectWs(session.id);
    await c2.waitForType("session_state");

    // Client 2 sends a follow-up — pushed into existing stream (no abort-and-replace)
    c2.ws.send(JSON.stringify({ type: "message", content: "hello from client 2" }));

    // Wait for the second done from the follow-up turn
    await c1.waitForNthType("done", 2, 15000);

    // Client 1 should have received text events from both turns
    const c1Texts = c1.messages.filter((m) => m.type === "text");
    expect(c1Texts.length).toBeGreaterThan(0);

    c1.close();
    c2.close();
  });

  // ─── cross-client approval response ───

  it("approval_response from a different client is accepted", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect client 1, trigger approval_request with "delete"
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "delete temp files" }));

    // Wait for approval_request
    const approval = await c1.waitForType("approval_request");
    expect(approval.requestId).toBeDefined();

    // Connect client 2 while c1's stream is in progress
    const c2 = await connectWs(session.id);
    await c2.waitForType("session_state");

    // Client 2 also should have received the approval_request via turn_events or live broadcast
    // Send approval_response from client 2
    c2.ws.send(JSON.stringify({
      type: "approval_response",
      requestId: approval.requestId,
      approved: true,
    }));

    // Both clients should receive a phase_changed broadcast (approval cleared)
    await new Promise((r) => setTimeout(r, 300));
    const c2PhaseChanges = c2.messages.filter((m) => m.type === "phase_changed");
    expect(c2PhaseChanges.length).toBeGreaterThan(0);

    // Wait for stream to finish
    await c1.waitForType("done");

    c1.close();
    c2.close();
  });

  // ─── message sent instead of answering a pending approval ───

  it("sending a message while an approval is pending auto-skips it", async () => {
    const session = await chatService.createSession("mock", {});

    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");

    // Trigger an approval_request
    c1.ws.send(JSON.stringify({ type: "message", content: "delete temp files" }));
    const approval = await c1.waitForType("approval_request");
    expect(approval.requestId).toBeDefined();

    // Instead of answering, send a new message — server must auto-skip the
    // pending approval so the (real-SDK) blocked generator gets unblocked.
    c1.ws.send(JSON.stringify({ type: "message", content: "actually do this instead" }));

    const resolved = await c1.waitForType("approval_resolved");
    expect(resolved.requestId).toBe(approval.requestId);
    expect(resolved.approved).toBe(false);

    c1.close();
  });

  // ─── race condition: stream finishes between REST and WS connect ───

  it("client connecting right after stream ends gets idle state without stale turn_events", async () => {
    const session = await chatService.createSession("mock", {});

    // Connect, send message, wait for done
    const c1 = await connectWs(session.id);
    await c1.waitForType("session_state");
    c1.ws.send(JSON.stringify({ type: "message", content: "hello race test" }));
    await c1.waitForType("done");

    // Wait for idle phase (sent after done in finally block)
    await new Promise((r) => setTimeout(r, 100));

    // Simulate: client 2 connects right after stream ended
    // (represents the window between REST history fetch and WS connect)
    // turnEvents should already be cleared in the finally block
    const c2 = await connectWs(session.id);
    const state = await c2.waitForType("session_state");
    expect(state.phase).toBe("idle");

    // Should NOT get any turn_events (buffer was cleared before idle)
    await new Promise((r) => setTimeout(r, 300));
    const turnEvents = c2.messages.filter((m) => m.type === "turn_events");
    expect(turnEvents).toHaveLength(0);

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

describe("Chat WebSocket — per-session effort + thinking", () => {
  it("set_effort with a valid value persists and echoes in session_state", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, waitForNthType, close } = await connectWs(session.id);

    ws.send(JSON.stringify({ type: "set_effort", effort: "xhigh" }));
    const state = await waitForNthType("session_state", 2);
    expect(state.effort).toBe("xhigh");
    expect(getSessionEffort(session.id)).toBe("xhigh");

    close();
  });

  it("set_effort rejects 'extra' (would crash the CLI) and leaves effort unchanged", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, waitForType, close } = await connectWs(session.id);
    await waitForType("session_state");

    ws.send(JSON.stringify({ type: "set_effort", effort: "extra" }));
    const errMsg = await waitForType("error");
    expect(errMsg.message).toContain("effort must be one of");
    expect(getSessionEffort(session.id)).toBeNull();

    close();
  });

  it("set_thinking on/off toggles the per-session budget and session_state flag", async () => {
    const session = await chatService.createSession("mock", {});
    const { ws, waitForNthType, close } = await connectWs(session.id);

    ws.send(JSON.stringify({ type: "set_thinking", enabled: true }));
    const on = await waitForNthType("session_state", 2);
    expect(on.thinking).toBe(true);
    expect(getSessionThinking(session.id)).toBe(THINKING_ADAPTIVE);

    ws.send(JSON.stringify({ type: "set_thinking", enabled: false }));
    const off = await waitForNthType("session_state", 3);
    expect(off.thinking).toBe(false);
    expect(getSessionThinking(session.id)).toBe(0);

    close();
  });
});

// ---------------------------------------------------------------------------
// listRunningSessions — powers the tab-strip spinner for unmounted chat tabs
// ---------------------------------------------------------------------------

describe("listRunningSessions", () => {
  it("reports a session while its turn is in flight and drops it once idle", async () => {
    const { listRunningSessions } = await import("../../../src/server/ws/chat.ts");
    const session = await chatService.createSession("mock", {});
    const { ws, waitForType, close } = await connectWs(session.id);

    await waitForType("session_state");
    expect(listRunningSessions().some((s) => s.sessionId === session.id)).toBe(false);

    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    // Catch the turn mid-flight: poll until the session shows a non-idle phase.
    let seen: { sessionId: string; phase: string } | undefined;
    for (let i = 0; i < 100 && !seen; i++) {
      seen = listRunningSessions().find((s) => s.sessionId === session.id);
      if (!seen) await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).toBeDefined();
    expect(seen!.phase).not.toBe("idle");

    await waitForType("done");
    await new Promise((r) => setTimeout(r, 200));
    expect(listRunningSessions().some((s) => s.sessionId === session.id)).toBe(false);

    close();
  });

  it("matches its own project and excludes others", async () => {
    const { listRunningSessions } = await import("../../../src/server/ws/chat.ts");
    const session = await chatService.createSession("mock", {});
    // Carries a real projectName, so a positive match is actually asserted — a
    // session with no projectName would pass even if the filter were inverted.
    const { ws, waitForType, close } = await connectWs(session.id, "proj-alpha");

    await waitForType("session_state");
    ws.send(JSON.stringify({ type: "message", content: "hello" }));

    let seen: { sessionId: string; phase: string } | undefined;
    for (let i = 0; i < 100 && !seen; i++) {
      seen = listRunningSessions("proj-alpha").find((s) => s.sessionId === session.id);
      if (!seen) await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).toBeDefined();

    // Same instant, different project filter → must not appear.
    expect(listRunningSessions("proj-beta").some((s) => s.sessionId === session.id)).toBe(false);
    // Unfiltered still includes it.
    expect(listRunningSessions().some((s) => s.sessionId === session.id)).toBe(true);

    await waitForType("done");
    close();
  });
});


describe("Chat reply delivery", () => {
  const reference = (sessionId: string): ReplyReference => ({ version: 1, sessionId, providerId: "mock", messageId: "original", role: "assistant", timestamp: "2026-10-01T00:00:00Z", quote: "quoted prior answer <tool> & 😊", truncated: false });
  it("sends encoded reply to provider, echoes it and replays it on reconnect", async () => {
    const session = await chatService.createSession("mock", {});
    const c1 = await connectWs(session.id); const c2 = await connectWs(session.id);
    await c1.waitForType("session_state"); await c2.waitForType("session_state");
    const replyTo = reference(session.id);
    c1.ws.send(JSON.stringify({ type: "message", content: "follow this", replyTo }));
    const echo = await c2.waitForType("user_message");
    expect(echo.content).toBe(encodeReply("follow this", replyTo));
    await c1.waitForType("text");
    const c3 = await connectWs(session.id);
    const replay = await c3.waitForType("turn_events");
    expect(replay.userMessage).toBe(echo.content);
    await c1.waitForType("done");
    const history = await chatService.getMessages("mock", session.id);
    expect(decodeReply(history.find((m) => m.role === "user")!.content).replyTo).toEqual(replyTo);
    c1.close(); c2.close(); c3.close();
  });
  it("pushes the encoded snapshot for now, next and later followups", async () => {
    const session = await chatService.createSession("mock", {});
    const client = await connectWs(session.id); await client.waitForType("session_state");
    const provider = providerRegistry.get("mock")! as any;
    const originalPush = provider.pushMessage;
    const captured: Array<{ content: string; priority: string }> = [];
    provider.pushMessage = async (_id: string, content: string, opts: any) => { captured.push({ content, priority: opts.priority }); };
    try {
      client.ws.send(JSON.stringify({ type: "message", content: "first" }));
      await client.waitForType("text");
      for (const priority of ["now", "next", "later"]) {
        client.ws.send(JSON.stringify({ type: "message", content: priority, priority, replyTo: reference(session.id) }));
        for (let i = 0; i < 100 && captured.length < ["now", "next", "later"].indexOf(priority) + 1; i++) await Bun.sleep(5);
      }
      expect(captured.map((v) => v.priority)).toEqual(["now", "next", "later"]);
      for (const sent of captured) expect(decodeReply(sent.content)).toEqual({ content: sent.priority, replyTo: reference(session.id) });
      await client.waitForType("done");
    } finally { if (originalPush) provider.pushMessage = originalPush; else delete provider.pushMessage; client.close(); }
  });
  it("rejects wrong session/provider, malformed metadata and builtin replies before model changes or echo", async () => {
    const session = await chatService.createSession("mock", {});
    const c1 = await connectWs(session.id); const c2 = await connectWs(session.id);
    await c1.waitForType("session_state"); await c2.waitForType("session_state");
    const invalid = [{ ...reference(session.id), sessionId: "wrong" }, { ...reference(session.id), providerId: "claude" }, { ...reference(session.id), quote: "" }, reference(session.id)];
    for (let index = 0; index < invalid.length; index++) {
      const content = index === 3 ? "/version" : "question";
      c1.ws.send(JSON.stringify({ type: "message", content, replyTo: invalid[index], model: "must-not-persist" }));
      const rejected = await c1.waitForNthType("message_rejected", index + 1);
      expect(rejected.content).toBe(content);
    }
    expect(c2.messages.filter((m) => m.type === "user_message")).toHaveLength(0);
    expect(getSessionModel(session.id)).toBeNull();
    expect((await chatService.getMessages("mock", session.id))).toHaveLength(0);
    c1.close(); c2.close();
  });
});

describe("Chat WebSocket — what a notification is held back by", () => {
  /** The `stillUnseen` the chat handler hands the dispatcher, per notification type. */
  async function captureNotifications() {
    const { notificationService } = await import("../../../src/services/notification.service.ts");
    const sent: Array<{ type: string; stillUnseen?: () => boolean }> = [];
    const spy = spyOn(notificationService, "broadcast").mockImplementation(async (type, _payload, opts) => {
      sent.push({ type, stillUnseen: opts?.stillUnseen });
    });
    const next = async (type: string) => {
      for (let i = 0; i < 200 && !sent.some((s) => s.type === type); i++) await Bun.sleep(5);
      const found = sent.find((s) => s.type === type);
      expect(found?.stillUnseen).toBeFunction();
      return found!.stillUnseen!;
    };
    return { next, restore: () => spy.mockRestore() };
  }

  it("sends a finished chat's notification only while the chat is still unread", async () => {
    const notifications = await captureNotifications();
    try {
      const session = await chatService.createSession("mock", {});
      const client = await connectWs(session.id);
      await client.waitForType("session_state");
      client.ws.send(JSON.stringify({ type: "message", content: "hello" }));
      await client.waitForType("done");
      const stillUnseen = await notifications.next("done");
      expect(stillUnseen()).toBe(true);
      // What opening the chat on any device does (POST /chat/sessions/:id/read).
      clearSessionUnread(session.id);
      expect(stillUnseen()).toBe(false);
      client.close();
    } finally {
      notifications.restore();
    }
  });

  it("drops an approval's notification once the approval is answered", async () => {
    const notifications = await captureNotifications();
    try {
      const session = await chatService.createSession("mock", {});
      const client = await connectWs(session.id);
      await client.waitForType("session_state");
      client.ws.send(JSON.stringify({ type: "message", content: "delete temp files" }));
      const approval = await client.waitForType("approval_request");
      const stillUnseen = await notifications.next("approval_request");
      expect(stillUnseen()).toBe(true);
      client.ws.send(JSON.stringify({ type: "approval_response", requestId: approval.requestId, approved: true }));
      await client.waitForType("done");
      // Nobody opened the chat, so it is still unread: answering is what cancels this one.
      expect(getSessionUnreadCount(session.id)).toBeGreaterThan(0);
      expect(stillUnseen()).toBe(false);
      client.close();
    } finally {
      notifications.restore();
    }
  });
});

describe("Chat control from the server, with or without a browser", () => {
  const ctl = (): ChatControl => {
    const c = chatControl();
    if (!c) throw new Error("the chat socket layer registered no chat control");
    return c;
  };
  const until = async (check: () => boolean, ms = 5000) => {
    for (let waited = 0; !check() && waited < ms; waited += 10) await Bun.sleep(10);
    expect(check()).toBe(true);
  };

  type Heard = { [K in keyof ChatLifecycleEvents]: { name: K; payload: ChatLifecycleEvents[K] } }[keyof ChatLifecycleEvents];
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    for (const off of unsubscribes.splice(0)) off();
  });
  /** Every lifecycle event for one session, in order. */
  function listen(sessionId: () => string): Heard[] {
    const heard: Heard[] = [];
    const names: Array<keyof ChatLifecycleEvents> = ["stream", "user_message", "approval_shown", "approval_resolved", "turn_ended", "migrated"];
    for (const name of names) {
      unsubscribes.push(chatLifecycle.on(name, (payload: any) => {
        if (payload.sessionId === sessionId() || payload.oldSessionId === sessionId()) heard.push({ name, payload } as Heard);
      }));
    }
    return heard;
  }
  const ofName = <K extends keyof ChatLifecycleEvents>(heard: Heard[], name: K) =>
    heard.filter((h) => h.name === name).map((h) => h.payload as ChatLifecycleEvents[K]);

  /** An Assistant-capable provider that answers every message at once and records what it was given. */
  const turns: Array<{ sessionId: string; message: string; opts?: SendMessageOpts }> = [];
  const STUB = "stub-chat-control";
  providerRegistry.register({
    id: STUB, name: STUB, supportsAssistantSessions: true, supportsSharedContext: true,
    async createSession() { return { id: "unused", providerId: STUB, title: "", createdAt: "" }; },
    async resumeSession(id: string) { return { id, providerId: STUB, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts) {
      turns.push({ sessionId, message, opts });
      yield { type: "text", content: "Reply for the phone." };
      yield { type: "done", sessionId };
    },
  } as AIProvider);
  function assistantSession(): string {
    const id = `asst-${crypto.randomUUID()}`;
    setSessionAssistant(id);
    setSessionProvider(id, STUB);
    return id;
  }
  const turnsOf = (id: string) => turns.filter((t) => t.sessionId === id);

  it("runs a Telegram message through an Assistant session nobody has open, and is heard end to end", async () => {
    const id = assistantSession();
    const heard = listen(() => id);
    const result = await ctl().sendUserMessage(id, "what needs me today?", {
      origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: STUB,
    });
    expect(result).toEqual({ ok: true, sessionId: id });
    await until(() => ofName(heard, "turn_ended").length === 1);

    expect(heard[0]).toMatchObject({ name: "user_message", payload: { text: "what needs me today?", origin: "telegram", providerId: STUB, projectName: ASSISTANT_PROJECT_NAME } });
    const streamed = ofName(heard, "stream").map((s) => (s.event as { type: string }).type);
    expect(streamed).toEqual(expect.arrayContaining(["phase_changed", "text", "done"]));
    expect(ofName(heard, "turn_ended")[0]).toMatchObject({ outcome: "done", finalText: "Reply for the phone.", providerId: STUB });
    // The end comes after the turn's `done` reached the stream.
    const doneAt = heard.findIndex((h) => h.name === "stream" && (h.payload.event as { type?: string }).type === "done");
    expect(doneAt).toBeGreaterThan(0);
    expect(heard.findIndex((h) => h.name === "turn_ended")).toBeGreaterThan(doneAt);
    // The model is told no screen is attached to this turn.
    expect(turnsOf(id)[0]?.opts?.sharedContext).toContain(TELEGRAM_CHANNEL_CONTEXT_ENTRY);
    expect(ctl().liveState(id)).toMatchObject({ phase: "idle", running: false, queuedCards: 0 });
    expect(ctl().listLive().some((s) => s.sessionId === id)).toBe(true);
  });

  it("forgets the screen the model last saw once the user writes from Telegram", async () => {
    const id = assistantSession();
    const ui = { project: "web", layout: "desktop", panels: [], windows: [] };
    const c = await connectWs(id, ASSISTANT_PROJECT_NAME);
    await c.waitForType("session_state");
    const fromPpm = async (n: number) => {
      c.ws.send(JSON.stringify({ type: "message", content: `from ppm ${n}`, uiSummary: ui }));
      await until(() => turnsOf(id).length === n);
      await until(() => ctl().liveState(id)?.phase === "idle");
    };

    await fromPpm(1);
    expect(turnsOf(id)[0]?.opts?.sharedContext).toContain("Current project:");
    await fromPpm(2);
    // Unchanged, so not sent again.
    expect(turnsOf(id)[1]?.opts?.sharedContext ?? "").not.toContain("Current project:");

    expect((await ctl().sendUserMessage(id, "from the phone", { origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: STUB })).ok).toBe(true);
    await until(() => turnsOf(id).length === 3);
    await until(() => ctl().liveState(id)?.phase === "idle");
    expect(turnsOf(id)[2]?.opts?.sharedContext).toContain(TELEGRAM_CHANNEL_CONTEXT_ENTRY);
    expect(turnsOf(id)[2]?.opts?.sharedContext).not.toContain("Current project:");

    await fromPpm(4);
    expect(turnsOf(id)[3]?.opts?.sharedContext).toContain("Current project:");
    expect(turnsOf(id)[3]?.opts?.sharedContext).not.toContain(TELEGRAM_CHANNEL_CONTEXT_ENTRY);
    c.close();
  });

  it("leaves no PPM screen as the chatting device after a Telegram message, though one is open", async () => {
    const { deliverToChattingDevice } = await import("../../../src/server/ws/chat.ts");
    const session = await chatService.createSession("mock", {});
    const c = await connectWs(session.id);
    await c.waitForType("session_state");
    c.ws.send(JSON.stringify({ type: "message", content: "hello" }));
    await c.waitForType("done");
    await until(() => ctl().liveState(session.id)?.phase === "idle");
    expect(deliverToChattingDevice(session.id, { type: "probe" }, { strict: true })).toBe(1);

    const result = await ctl().sendUserMessage(session.id, "from the phone", { origin: "telegram", projectName: "unused", providerId: "mock" });
    expect(result.ok).toBe(true);
    expect(deliverToChattingDevice(session.id, { type: "probe" }, { strict: true })).toBe(0);
    // The open screen still shows the message: nobody there typed it.
    const echo = await c.waitForType("user_message");
    expect(echo.content).toBe("from the phone");
    await c.waitForNthType("done", 2);
    c.close();
  });

  it("settles a card once when the browser and Telegram both answer it, Telegram first", async () => {
    const session = await chatService.createSession("mock", {});
    const heard = listen(() => session.id);
    const c = await connectWs(session.id);
    await c.waitForType("session_state");
    c.ws.send(JSON.stringify({ type: "message", content: "delete temp files" }));
    const card = await c.waitForType("approval_request");
    expect(ofName(heard, "approval_shown")[0]?.card).toMatchObject({ requestId: card.requestId, tool: "Bash", isQuestion: false });
    expect(ctl().liveState(session.id)?.card?.requestId).toBe(card.requestId);

    expect(ctl().answerApproval(session.id, card.requestId, { approved: true }, "telegram")).toBe("answered");
    expect(ofName(heard, "approval_resolved")).toEqual([
      { sessionId: session.id, requestId: card.requestId, approved: true, reason: "answered", by: "telegram" },
    ]);
    const resolved = await c.waitForType("approval_resolved");
    expect(resolved).toMatchObject({ requestId: card.requestId, approved: true });

    c.ws.send(JSON.stringify({ type: "approval_response", requestId: card.requestId, approved: false }));
    const stale = await c.waitForType("approval_stale");
    expect(stale.requestId).toBe(card.requestId);
    expect(ctl().answerApproval(session.id, card.requestId, { approved: false }, "telegram")).toBe("stale");
    expect(ofName(heard, "approval_resolved")).toHaveLength(1);
    await c.waitForType("done");
    c.close();
  });

  it("settles a card once when the browser answers before Telegram", async () => {
    const session = await chatService.createSession("mock", {});
    const heard = listen(() => session.id);
    const c = await connectWs(session.id);
    await c.waitForType("session_state");
    c.ws.send(JSON.stringify({ type: "message", content: "remove the cache" }));
    const card = await c.waitForType("approval_request");
    c.ws.send(JSON.stringify({ type: "approval_response", requestId: card.requestId, approved: true }));
    await c.waitForType("approval_resolved");
    expect(ctl().answerApproval(session.id, card.requestId, { approved: true }, "telegram")).toBe("stale");
    expect(ofName(heard, "approval_resolved").map((r) => r.by)).toEqual(["ws"]);
    expect(c.messages.filter((m) => m.type === "approval_stale")).toHaveLength(0);
    await c.waitForType("done");
    c.close();
  });

  it("refuses a watch report as busy while a card waits, and leaves the card where it is", async () => {
    const session = await chatService.createSession("mock", {});
    const c = await connectWs(session.id);
    await c.waitForType("session_state");
    c.ws.send(JSON.stringify({ type: "message", content: "delete temp files" }));
    const card = await c.waitForType("approval_request");

    const result = await ctl().sendUserMessage(session.id, "<ppm-event>chat X finished</ppm-event>", { origin: "watch", projectName: "unused", providerId: "mock" });
    expect(result).toEqual({ ok: false, error: CHAT_BUSY });
    expect(ctl().liveState(session.id)?.card?.requestId).toBe(card.requestId);
    expect(c.messages.filter((m) => m.type === "approval_resolved" || m.type === "user_message")).toHaveLength(0);

    expect(ctl().answerApproval(session.id, card.requestId, { approved: true }, "telegram")).toBe("answered");
    await c.waitForType("done");
    c.close();
  });

  it("carries channel and origin into a message joining a running turn, and keeps a watch out of it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const HELD = "stub-chat-control-held";
    providerRegistry.register({
      id: HELD, name: HELD, supportsAssistantSessions: true, supportsSharedContext: true,
      async createSession() { return { id: "unused", providerId: HELD, title: "", createdAt: "" }; },
      async resumeSession(id: string) { return { id, providerId: HELD, title: "", createdAt: "" }; },
      async listSessions() { return []; },
      async deleteSession() {},
      async *sendMessage(sessionId: string) {
        yield { type: "text", content: "working" };
        await gate;
        yield { type: "done", sessionId };
      },
      pushMessage() {},
    } as AIProvider);
    const id = `held-${crypto.randomUUID()}`;
    setSessionAssistant(id);
    setSessionProvider(id, HELD);
    const pushed = spyOn(chatService, "pushMessage").mockImplementation(async () => {});
    const opts = { origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: HELD } as const;
    try {
      expect((await ctl().sendUserMessage(id, "start", opts)).ok).toBe(true);
      // Streaming, not merely starting: only a running consumer takes a message as a follow-up.
      await until(() => ctl().liveState(id)?.phase === "streaming");
      expect((await ctl().sendUserMessage(id, "and this", opts)).ok).toBe(true);
      expect(pushed).toHaveBeenCalledWith(HELD, id, "and this", expect.objectContaining({ origin: "telegram", channel: "telegram" }));
      // A watch report never joins a turn the user is in the middle of.
      const report = { origin: "watch", projectName: ASSISTANT_PROJECT_NAME, providerId: HELD } as const;
      expect(await ctl().sendUserMessage(id, "<ppm-event>done</ppm-event>", report)).toEqual({ ok: false, error: CHAT_BUSY });
      expect(pushed).toHaveBeenCalledTimes(1);
      release();
      await until(() => ctl().liveState(id)?.phase === "idle");
      expect((await ctl().sendUserMessage(id, "<ppm-event>done</ppm-event>", report)).ok).toBe(true);
    } finally {
      release();
      pushed.mockRestore();
    }
  });

  it("stops a running turn and reports its end; an unknown chat has nothing to stop", async () => {
    const session = await chatService.createSession("mock", {});
    const heard = listen(() => session.id);
    const c = await connectWs(session.id);
    await c.waitForType("session_state");
    c.ws.send(JSON.stringify({ type: "message", content: "tell me a long story" }));
    await c.waitForType("text");
    expect(ctl().listLive().find((s) => s.sessionId === session.id)?.running).toBe(true);
    expect(ctl().cancelTurn(session.id, "telegram")).toBe(true);
    await until(() => ofName(heard, "turn_ended").length === 1);
    expect(ctl().liveState(session.id)?.running).toBe(false);
    expect(ctl().cancelTurn(`missing-${crypto.randomUUID()}`, "telegram")).toBe(false);
    expect(ctl().liveState(`missing-${crypto.randomUUID()}`)).toBeNull();
    c.close();
  });

  it("refuses what no server-side sender may send", async () => {
    const session = await chatService.createSession("mock", {});
    const send = (text: string, extra: Record<string, unknown> = {}) =>
      ctl().sendUserMessage(session.id, text, { origin: "telegram", projectName: "unused", providerId: "mock", ...extra } as never);
    expect((await send("  ")).ok).toBe(false);
    expect((await send("hi", { origin: "ws" })).ok).toBe(false);
    expect((await send("hi", { permissionMode: "yolo" })).ok).toBe(false);
    expect((await send("hi", { images: [{ data: "x", mediaType: "image/tiff" }] })).ok).toBe(false);
    expect((await send("hi", { images: Array.from({ length: 6 }, () => ({ data: "x", mediaType: "image/png" })) })).ok).toBe(false);
    const unregistered = await ctl().sendUserMessage(`fresh-${crypto.randomUUID()}`, "hi", { origin: "telegram", projectName: `nope-${crypto.randomUUID()}`, providerId: "mock" });
    expect(unregistered.ok).toBe(false);
  });

  it("holds back the notifications a suppressor claims, and still marks the chat unread", async () => {
    const { notificationService } = await import("../../../src/services/notification.service.ts");
    const sent: Array<{ type: string; sessionId?: string }> = [];
    const spy = spyOn(notificationService, "broadcast").mockImplementation(async (type, payload) => {
      sent.push({ type, sessionId: (payload as { sessionId?: string }).sessionId });
    });
    try {
      const session = await chatService.createSession("mock", {});
      unsubscribes.push(addNotificationSuppressor((sessionId) => sessionId === session.id));
      const c = await connectWs(session.id);
      await c.waitForType("session_state");
      c.ws.send(JSON.stringify({ type: "message", content: "delete temp files" }));
      const card = await c.waitForType("approval_request");
      c.ws.send(JSON.stringify({ type: "approval_response", requestId: card.requestId, approved: true }));
      await c.waitForType("done");
      await Bun.sleep(150);
      expect(sent.filter((s) => s.sessionId === session.id)).toEqual([]);
      expect(getSessionUnreadCount(session.id)).toBeGreaterThan(0);
      c.close();
    } finally {
      spy.mockRestore();
    }
  });
});
