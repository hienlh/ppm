import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket, listRunningSessions } from "../../../src/server/ws/chat.ts";

it("keeps child events out of the root lifecycle and completed-turn reconnect replay", async () => {
  const session = await chatService.createSession("mock", {});
  const pending: any[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let consumerEnded!: () => void;
  const ended = new Promise<void>((resolve) => { consumerEnded = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    try {
      while (!finished) {
        if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
        while (pending.length) yield pending.shift();
      }
    } finally { consumerEnded(); }
  });
  const sockets: any[] = [];
  function connect() {
    const messages: any[] = [];
    const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages };
  }
  async function emit(event: any) {
    const count = live.messages.length;
    pending.push(event);
    wake?.();
    wake = undefined;
    for (let i = 0; i < 100; i++) {
      if (live.messages.slice(count).some((message) => message.type === event.type && message.content === event.content)) return;
      await Bun.sleep(5);
    }
    throw new Error(`Consumer did not forward ${event.type}`);
  }
  const live = connect();
  try {
    await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "root request" }));
    await emit({ type: "thinking", content: "child first", parentToolUseId: "subagent-worker" });
    expect(live.messages.filter((message) => message.type === "phase_changed").at(-1).phase).toBe("connecting");

    await emit({ type: "text", content: "root answer" });
    await emit({ type: "done", parentToolUseId: "subagent-worker" });
    expect(listRunningSessions().some((running) => running.sessionId === session.id)).toBe(true);
    const inFlight = connect();
    const replay = inFlight.messages.find((message) => message.type === "turn_events");
    expect(replay.events.some((event: any) => event.content === "root answer")).toBe(true);

    await emit({ type: "done" });
    const afterRootDone = live.messages.length;
    await emit({ type: "text", content: "late child", parentToolUseId: "subagent-worker" });
    await emit({ type: "done", parentToolUseId: "subagent-worker" });
    await emit({ type: "tool_result", toolUseId: "subagent-worker", output: "completed", isError: false });
    expect(live.messages.slice(afterRootDone).some((message) => message.type === "phase_changed")).toBe(false);
    expect(listRunningSessions().some((running) => running.sessionId === session.id)).toBe(false);
    const idle = connect();
    expect(idle.messages.find((message) => message.type === "session_state").phase).toBe("idle");
    expect(idle.messages.some((message) => message.type === "turn_events")).toBe(false);

    // A provider may start queued root work without another WebSocket message.
    await emit({ type: "text", content: "queued root answer" });
    const queued = connect();
    expect(queued.messages.find((message) => message.type === "session_state").phase).toBe("streaming");
    const queuedReplay = queued.messages.find((message) => message.type === "turn_events");
    expect(queuedReplay.events.map((event: any) => event.content)).toEqual(["queued root answer"]);
    await emit({ type: "done" });
  } finally {
    finished = true;
    wake?.();
    await ended;
    send.mockRestore();
    for (const socket of sockets) chatWebSocket.close(socket);
  }
});
