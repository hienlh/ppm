/**
 * The reconnect replay names the id the running turn's prompt was sent under, so the browser can
 * keep that prompt bound to its turn (`turn_started` binds by that id).
 */
import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";

it("sends the running prompt's client id with the turn_events replay", async () => {
  const session = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const sockets: any[] = [];
  const connect = () => {
    const messages: any[] = [];
    const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages };
  };
  try {
    const first = connect();
    await chatWebSocket.message(first.socket as any, JSON.stringify({ type: "message", content: "hello", clientMessageId: "user-1-1-abc" }));
    for (let i = 0; i < 100 && !first.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
    const late = connect();
    const replay = late.messages.find((m) => m.type === "turn_events");
    expect(replay.userMessage).toBe("hello");
    expect(replay.clientMessageId).toBe("user-1-1-abc");
  } finally {
    release();
    send.mockRestore();
    for (const socket of sockets) chatWebSocket.close(socket);
  }
});
