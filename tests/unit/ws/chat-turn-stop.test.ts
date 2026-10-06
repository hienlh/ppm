/**
 * A turn ended by an error has to be said three ways: to the socket watching it (`turn_stop`),
 * to whoever opens the session later (`session_state.turnStop`, read from the trace because the
 * transcript has no record of the stop), and in the notification — which used to announce a
 * Max Turns stop as "Chat completed". Driven through the real ChatService so the trace is real.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { notificationService } from "../../../src/services/notification.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";

const MAX_TURNS = "Agent reached maximum turn limit.\nReached maximum number of turns (500)";

const restores: Array<() => void> = [];
const sockets: any[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  for (const restore of restores.splice(0)) restore();
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  return { socket, messages };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Make the mock provider answer every message with `events`. */
function script(events: (sessionId: string) => any[]) {
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string) {
    for (const event of events(sessionId)) yield event;
  } as never);
  restores.push(() => send.mockRestore());
}

function captureNotifications() {
  const sent: any[] = [];
  const spy = spyOn(notificationService, "broadcast").mockImplementation(((type: string, payload: unknown) => { sent.push({ type, payload }); }) as never);
  restores.push(() => spy.mockRestore());
  return sent;
}

it("tells the live socket, a later reconnect and the notification that Max Turns stopped the turn", async () => {
  const session = await chatService.createSession("mock", {});
  script((sid) => [
    { type: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId: "t1" },
    { type: "tool_result", output: "ok", toolUseId: "t1" },
    { type: "error", message: MAX_TURNS },
    { type: "done", sessionId: sid, resultSubtype: "error_max_turns", numTurns: 501 },
  ]);
  const sent = captureNotifications();
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "build the whole thing" }));
  await until(() => live.messages.some((m) => m.type === "phase_changed" && m.phase === "idle"), "the turn to end");

  const stopAt = live.messages.findIndex((m) => m.type === "turn_stop");
  expect(live.messages[stopAt]?.stop).toMatchObject({ message: MAX_TURNS, subtype: "error_max_turns" });
  // Ahead of the `done`, so the bar is in place by the time the session goes idle.
  expect(stopAt).toBeLessThan(live.messages.findIndex((m) => m.type === "done"));

  await until(() => sent.length > 0, "the notification");
  expect(sent[0].payload.title).toBe("Chat stopped");
  expect(sent[0].payload.detail).toContain("Stopped after 500 steps (Max Turns)");

  const later = connect(session.id);
  const greeting = later.messages.find((m) => m.type === "session_state");
  expect(greeting.turnStop).toMatchObject({ subtype: "error_max_turns" });
});

it("says nothing about a stop for a turn that finished, and the next message clears an earlier one", async () => {
  const session = await chatService.createSession("mock", {});
  let stopNext = true;
  script((sid) => stopNext
    ? [{ type: "error", message: MAX_TURNS }, { type: "done", sessionId: sid, resultSubtype: "error_max_turns" }]
    : [{ type: "text", content: "Finished." }, { type: "done", sessionId: sid, resultSubtype: "success" }]);
  const sent = captureNotifications();
  const live = connect(session.id);
  const idleCount = () => live.messages.filter((m) => m.type === "phase_changed" && m.phase === "idle").length;

  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "go" }));
  await until(() => idleCount() === 1, "the first turn to end");
  stopNext = false;
  const before = live.messages.length;
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "Continue from where you left off." }));
  await until(() => idleCount() === 2, "the second turn to end");

  expect(live.messages.slice(before).some((m) => m.type === "turn_stop")).toBe(false);
  await until(() => sent.length === 2, "both notifications");
  expect(sent[1].payload.title).toBe("Chat completed");
  expect(sent[1].payload.detail).toBe("Finished.");
  expect(connect(session.id).messages.find((m) => m.type === "session_state").turnStop).toBeNull();
});
