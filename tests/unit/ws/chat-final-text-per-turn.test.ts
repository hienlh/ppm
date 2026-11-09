/**
 * A "Chat completed" notification quotes the turn's answer, and only that turn's. The Claude
 * provider keeps one stream for the life of its subprocess: a follow-up is pushed into it, and
 * the consumer reading it never restarts between turns. The answer used to be reset only when a
 * consumer started or a tool ran, so the second turn quoted the first turn's text before its own.
 * Driven through the real ChatService, with a provider stream that spans turns as Claude's does.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { notificationService } from "../../../src/services/notification.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";

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

/** One stream for every turn, as Claude's: `turns[n]` answers the n-th message, pushed or first. */
function streamAcrossTurns(turns: Array<(sessionId: string) => any[]>) {
  const provider = providerRegistry.get("mock")! as any;
  const pushed: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string) {
    for (let turn = 0; turn < turns.length && !ended; turn++) {
      if (turn > 0) {
        while (pushed.length < turn && !ended) await new Promise<void>((r) => { wake = r; });
        if (ended) return;
      }
      for (const event of turns[turn]!(sessionId)) yield event;
    }
    while (!ended) await new Promise<void>((r) => { wake = r; });
  } as never);
  provider.pushMessage = (_id: string, content: string) => { pushed.push(content); const w = wake; wake = null; w?.(); };
  restores.push(() => {
    ended = true;
    const w = wake; wake = null; w?.();
    send.mockRestore();
    delete provider.pushMessage;
  });
}

function captureNotifications() {
  const sent: any[] = [];
  const spy = spyOn(notificationService, "broadcast").mockImplementation(((type: string, payload: unknown) => { sent.push({ type, payload }); }) as never);
  restores.push(() => spy.mockRestore());
  return sent;
}

async function twoTurns(second: (sessionId: string) => any[]) {
  const session = await chatService.createSession("mock", {});
  streamAcrossTurns([
    (sid) => [{ type: "text", content: "Sure, I will tell you when it finishes." }, { type: "done", sessionId: sid, resultSubtype: "success" }],
    second,
  ]);
  const sent = captureNotifications();
  const live = connect(session.id);
  const idle = () => live.messages.filter((m) => m.type === "phase_changed" && m.phase === "idle").length;
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "watch the build" }));
  await until(() => idle() === 1 && sent.length === 1, "the first turn's notification");
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "how did it go?" }));
  await until(() => idle() === 2 && sent.length === 2, "the second turn's notification");
  return sent;
}

it("quotes only the second turn's answer when both turns run on one stream", async () => {
  const sent = await twoTurns((sid) => [{ type: "text", content: "Your build finished." }, { type: "done", sessionId: sid, resultSubtype: "success" }]);
  expect(sent[0].payload.detail).toBe("Sure, I will tell you when it finishes.");
  expect(sent[1].payload.detail).toBe("Your build finished.");
});

it("quotes nothing for a second turn that wrote nothing", async () => {
  const sent = await twoTurns((sid) => [{ type: "done", sessionId: sid, resultSubtype: "success" }]);
  expect(sent[1].payload.title).toBe("Chat completed");
  expect(sent[1].payload.detail).toBeUndefined();
});
