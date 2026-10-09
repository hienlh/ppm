import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { assistantUiBroker, ASSISTANT_UI_NO_DEVICE_MESSAGE } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { tabOpenBroker } from "../../../src/services/tab-tools-mcp/tab-open-broker.ts";

const GET_STATE = { op: "get_state" as const, args: {} };

function harness() {
  const sockets: any[] = [];
  const connect = (sessionId: string) => {
    const messages: any[] = [];
    const socket = { data: { sessionId }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return {
      socket, messages,
      asks: () => messages.filter((m) => m.type === "assistant_ui"),
      opens: () => messages.filter((m) => m.type === "tab_open"),
    };
  };
  const answer = (socket: unknown, requestId: string, data: unknown = { currentProject: "demo" }) =>
    chatWebSocket.message(socket as any, JSON.stringify({ type: "assistant_ui_result", requestId, ok: true, data }));
  return { connect, answer, closeAll: () => { for (const s of sockets) chatWebSocket.close(s); } };
}

it("asks only the device that sent the latest message, and nobody once it has gone", async () => {
  const session = await chatService.createSession("mock", {});
  const other = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const { connect, answer, closeAll } = harness();
  try {
    const phone = connect(session.id);
    const desktop = connect(session.id);
    await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "what is open?" }));
    for (let i = 0; i < 100 && !phone.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);

    const first = assistantUiBroker.request(session.id, GET_STATE, 2000);
    expect(phone.asks().length).toBe(1);
    expect(desktop.asks().length).toBe(0);
    const ask = phone.asks()[0];
    expect(ask).toMatchObject({ type: "assistant_ui", op: "get_state", args: {} });
    // Another chat's device cannot settle it, nor can a device of this chat that was not asked.
    const stranger = connect(other.id);
    await answer(stranger.socket, ask.requestId);
    expect(assistantUiBroker.pendingCount()).toBe(1);
    await answer(phone.socket, ask.requestId, { currentProject: "phone-layout" });
    expect(await first).toMatchObject({ ok: true, result: { ok: true, data: { currentProject: "phone-layout" } } });

    // A device joining mid-turn is not handed the request again.
    const late = connect(session.id);
    expect(late.asks().length).toBe(0);

    // The phone locked: no other device is asked, and the agent is told why.
    chatWebSocket.close(phone.socket as any);
    const second = await assistantUiBroker.request(session.id, GET_STATE, 2000);
    expect(second).toEqual({ ok: false, reason: "no-device", message: ASSISTANT_UI_NO_DEVICE_MESSAGE });
    expect(desktop.asks().length).toBe(0);
    expect(late.asks().length).toBe(0);
    expect(assistantUiBroker.pendingCount()).toBe(0);

    // The tab tools keep their fallback to every device showing the chat.
    const opened = tabOpenBroker.request(session.id, { tool: "open_file", filePath: "a.ts", projectName: null }, 2000);
    expect(desktop.opens().length).toBe(1);
    expect(late.opens().length).toBe(1);
    await chatWebSocket.message(desktop.socket as any, JSON.stringify({ type: "tab_open_result", requestId: desktop.opens()[0].requestId, opened: true }));
    expect((await opened).ok).toBe(true);

    // Whoever sends next is the device asked from then on.
    await chatWebSocket.message(desktop.socket as any, JSON.stringify({ type: "message", content: "and now?" }));
    const third = assistantUiBroker.request(session.id, GET_STATE, 2000);
    expect(desktop.asks().length).toBe(1);
    expect(late.asks().length).toBe(0);
    await answer(desktop.socket, desktop.asks()[0].requestId);
    expect((await third).ok).toBe(true);
  } finally {
    release();
    send.mockRestore();
    closeAll();
  }
});

it("reaches the chatting device after the provider renames the session mid-turn", async () => {
  // Codex: the token's session id is the PPM draft id; the sockets move to the thread's id.
  const session = await chatService.createSession("mock", {});
  const threadId = `thread-${session.id}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "session_migrated", oldSessionId: session.id, newSessionId: threadId } as any;
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const { connect, answer, closeAll } = harness();
  try {
    const device = connect(session.id);
    await chatWebSocket.message(device.socket as any, JSON.stringify({ type: "message", content: "what is open?" }));
    for (let i = 0; i < 100 && !device.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
    expect(device.socket.data.sessionId).toBe(threadId);

    const call = assistantUiBroker.request(session.id, GET_STATE, 2000);
    const ask = device.asks()[0];
    expect(ask).toBeDefined();
    await answer(device.socket, ask.requestId);
    expect(await call).toMatchObject({ ok: true, result: { requestId: ask.requestId, ok: true } });
  } finally {
    release();
    send.mockRestore();
    closeAll();
  }
});

it("drops a malformed answer without settling the call", async () => {
  const session = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const { connect, closeAll } = harness();
  try {
    const device = connect(session.id);
    await chatWebSocket.message(device.socket as any, JSON.stringify({ type: "message", content: "hi" }));
    for (let i = 0; i < 100 && !device.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
    const call = assistantUiBroker.request(session.id, GET_STATE, 200);
    const { requestId } = device.asks()[0];
    await chatWebSocket.message(device.socket as any, JSON.stringify({ type: "assistant_ui_result", requestId, ok: "yes" }));
    expect(assistantUiBroker.pendingCount()).toBe(1);
    expect(await call).toMatchObject({ ok: false, reason: "timeout" });
  } finally {
    release();
    send.mockRestore();
    closeAll();
  }
});
