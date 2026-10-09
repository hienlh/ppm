import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatSocketData, chatWebSocket } from "../../../src/server/ws/chat.ts";
import { assistantUiBroker, ASSISTANT_UI_NO_DEVICE_MESSAGE } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { tabOpenBroker } from "../../../src/services/tab-tools-mcp/tab-open-broker.ts";

const GET_STATE = { op: "get_state" as const, args: {} };

function harness() {
  const sockets: any[] = [];
  /** `clientId`: the browser tab the socket belongs to, as the client sends it with each connection. */
  const connect = (sessionId: string, clientId?: string) => {
    const messages: any[] = [];
    const socket = { data: { sessionId, clientId }, send: (json: string) => messages.push(JSON.parse(json)) };
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

const PHONE_TAB = "phone-tab-0001";
const LAPTOP_TAB = "laptop-tab-0002";

/** A turn held open, so a reconnect lands mid-turn the way it does in a browser. */
function heldTurn(events: object[] = []) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    for (const e of events) yield e as any;
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  return { release: () => { release(); send.mockRestore(); } };
}

const waitForText = async (device: { messages: any[] }) => {
  for (let i = 0; i < 100 && !device.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
};

it("still reaches the chatting tab after its socket reconnects", async () => {
  const session = await chatService.createSession("mock", {});
  const turn = heldTurn();
  const { connect, answer, closeAll } = harness();
  try {
    const phone = connect(session.id, PHONE_TAB);
    const laptop = connect(session.id, LAPTOP_TAB);
    await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "what is open?" }));
    await waitForText(phone);
    // The new socket opens before the old one closes, as a browser reconnect often does.
    const phoneAgain = connect(session.id, PHONE_TAB);
    chatWebSocket.close(phone.socket as any);

    const call = assistantUiBroker.request(session.id, GET_STATE, 2000);
    expect(phoneAgain.asks()).toHaveLength(1);
    expect(laptop.asks()).toHaveLength(0);
    await answer(phoneAgain.socket, phoneAgain.asks()[0].requestId);
    expect((await call).ok).toBe(true);
  } finally {
    turn.release();
    closeAll();
  }
});

it("still reaches the chatting tab after a rename reopens its socket under the new id", async () => {
  const session = await chatService.createSession("mock", {});
  const threadId = `thread-${session.id}`;
  const turn = heldTurn([{ type: "session_migrated", oldSessionId: session.id, newSessionId: threadId }]);
  const { connect, answer, closeAll } = harness();
  try {
    const device = connect(session.id, PHONE_TAB);
    await chatWebSocket.message(device.socket as any, JSON.stringify({ type: "message", content: "what is open?" }));
    await waitForText(device);
    // The browser follows the rename: it closes the old socket and opens one under the thread id.
    chatWebSocket.close(device.socket as any);
    const reopened = connect(threadId, PHONE_TAB);

    const call = assistantUiBroker.request(session.id, GET_STATE, 2000);
    expect(reopened.asks()).toHaveLength(1);
    await answer(reopened.socket, reopened.asks()[0].requestId);
    expect((await call).ok).toBe(true);
  } finally {
    turn.release();
    closeAll();
  }
});

it("does not take another tab, or a tab with no id, for the chatting one", async () => {
  const session = await chatService.createSession("mock", {});
  const turn = heldTurn();
  const { connect, closeAll } = harness();
  try {
    const phone = connect(session.id, PHONE_TAB);
    await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "what is open?" }));
    await waitForText(phone);
    chatWebSocket.close(phone.socket as any);
    const laptop = connect(session.id, LAPTOP_TAB);
    const unnamed = connect(session.id);

    expect(await assistantUiBroker.request(session.id, GET_STATE, 2000)).toEqual({
      ok: false, reason: "no-device", message: ASSISTANT_UI_NO_DEVICE_MESSAGE,
    });
    expect(laptop.asks()).toHaveLength(0);
    expect(unnamed.asks()).toHaveLength(0);

    // The tab tools still go to every device showing the chat once the sender has gone.
    const opened = tabOpenBroker.request(session.id, { tool: "open_file", filePath: "a.ts", projectName: null }, 2000);
    expect(laptop.opens()).toHaveLength(1);
    expect(unnamed.opens()).toHaveLength(1);
    await chatWebSocket.message(laptop.socket as any, JSON.stringify({ type: "tab_open_result", requestId: laptop.opens()[0].requestId, opened: true }));
    expect((await opened).ok).toBe(true);
  } finally {
    turn.release();
    closeAll();
  }
});

it("forgets the previous tab when the next message comes from a tab that sends no id", async () => {
  const session = await chatService.createSession("mock", {});
  const turn = heldTurn();
  const { connect, closeAll } = harness();
  try {
    const phone = connect(session.id, PHONE_TAB);
    const older = connect(session.id);
    await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "first" }));
    await waitForText(phone);
    await chatWebSocket.message(older.socket as any, JSON.stringify({ type: "message", content: "second" }));
    chatWebSocket.close(older.socket as any);
    // The phone tab is still connected, but it is not the one the user is talking from now.
    expect(await assistantUiBroker.request(session.id, GET_STATE, 2000)).toMatchObject({ ok: false, reason: "no-device" });
    expect(phone.asks()).toHaveLength(0);
  } finally {
    turn.release();
    closeAll();
  }
});

it("keeps the chatting tab across a rename when the sockets are built from their upgrade URLs", async () => {
  // As the browser connects (use-chat.ts) and the server reads it (src/server/index.ts): the tab's
  // id rides the query, and a server that drops it leaves no socket recognisable as that tab.
  const fromUrl = (sessionId: string) =>
    chatSocketData(sessionId, "demo", new URL(`http://h/ws/project/demo/chat/${sessionId}?providerId=mock&clientId=${PHONE_TAB}`).searchParams);
  const session = await chatService.createSession("mock", {});
  const threadId = `thread-${session.id}`;
  const turn = heldTurn([{ type: "session_migrated", oldSessionId: session.id, newSessionId: threadId }]);
  const socket = (sessionId: string) => {
    const messages: any[] = [];
    return { data: fromUrl(sessionId), messages, send: (json: string) => messages.push(JSON.parse(json)) };
  };
  const first = socket(session.id);
  const reopened = socket(threadId);
  try {
    expect(first.data).toMatchObject({ type: "chat", sessionId: session.id, providerHint: "mock", clientId: PHONE_TAB });
    chatWebSocket.open(first as any);
    await chatWebSocket.message(first as any, JSON.stringify({ type: "message", content: "what is open?" }));
    await waitForText(first);
    // The rename: the old socket closes, then the tab reopens under the thread id.
    chatWebSocket.close(first as any);
    chatWebSocket.open(reopened as any);

    const call = assistantUiBroker.request(threadId, GET_STATE, 2000);
    const ask = reopened.messages.find((m) => m.type === "assistant_ui");
    expect(ask).toBeDefined();
    await chatWebSocket.message(reopened as any, JSON.stringify({ type: "assistant_ui_result", requestId: ask.requestId, ok: true, data: { currentProject: "demo" } }));
    expect((await call).ok).toBe(true);
  } finally {
    turn.release();
    chatWebSocket.close(reopened as any);
  }
});

it("reads no client id from a query that carries none or a malformed one", () => {
  const read = (query: string) => chatSocketData("s", "demo", new URLSearchParams(query)).clientId;
  expect(read("providerId=codex")).toBeUndefined();
  expect(read("clientId=../../x")).toBeUndefined();
  expect(read(`clientId=${LAPTOP_TAB}`)).toBe(LAPTOP_TAB);
});
