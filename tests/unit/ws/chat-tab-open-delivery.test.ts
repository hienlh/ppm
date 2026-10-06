import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { tabOpenBroker } from "../../../src/services/tab-tools-mcp/tab-open-broker.ts";

const REQ = { tool: "open_preview" as const, filePath: "site/report.html", projectName: null, check: { screenshot: true } };

it("opens the tab on the device that sent the turn's message, falls back to every device, and is never replayed", async () => {
  const session = await chatService.createSession("mock", {});
  const other = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const sockets: any[] = [];
  const connect = (sessionId = session.id) => {
    const messages: any[] = [];
    const socket = { data: { sessionId }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages, opens: () => messages.filter((m) => m.type === "tab_open") };
  };
  const answer = (socket: unknown, requestId: string) =>
    chatWebSocket.message(socket as any, JSON.stringify({ type: "tab_open_result", requestId, opened: true }));
  try {
    const phone = connect();
    const desktop = connect();
    await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "make a chart" }));
    for (let i = 0; i < 100 && !phone.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);

    const first = tabOpenBroker.request(session.id, REQ, 2000);
    expect(phone.opens().length).toBe(1);
    expect(desktop.opens().length).toBe(0);
    const requestId = phone.opens()[0].requestId;
    // Another chat's device cannot settle it.
    const stranger = connect(other.id);
    await answer(stranger.socket, requestId);
    expect(tabOpenBroker.pendingCount()).toBe(1);
    await answer(phone.socket, requestId);
    expect(await first).toMatchObject({ ok: true, result: { requestId, opened: true } });

    // A device joining mid-turn is not handed the tab again.
    const late = connect();
    const replay = late.messages.find((m) => m.type === "turn_events");
    expect(replay.events.some((e: any) => e.type === "text")).toBe(true);
    expect(replay.events.some((e: any) => e.type === "tab_open")).toBe(false);
    expect(late.opens().length).toBe(0);

    // The phone locked: every device still showing the chat gets the next one.
    chatWebSocket.close(phone.socket as any);
    const second = tabOpenBroker.request(session.id, REQ, 2000);
    expect(desktop.opens().length).toBe(1);
    expect(late.opens().length).toBe(1);
    await answer(late.socket, late.opens()[0].requestId);
    expect((await second).ok).toBe(true);
    expect(tabOpenBroker.pendingCount()).toBe(0);
  } finally {
    release();
    send.mockRestore();
    for (const socket of sockets) chatWebSocket.close(socket);
  }
});

it("reaches the chat's device after the provider renames the session mid-turn", async () => {
  // Codex: the PPM id the turn's tab-tools token was issued under becomes the thread's id.
  const session = await chatService.createSession("mock", {});
  const threadId = `thread-${session.id}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "session_migrated", oldSessionId: session.id, newSessionId: threadId } as any;
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const messages: any[] = [];
  const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as any);
  try {
    await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "make a chart" }));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
    expect(socket.data.sessionId).toBe(threadId);

    const call = tabOpenBroker.request(session.id, REQ, 2000);
    const open = messages.find((m) => m.type === "tab_open");
    expect(open).toBeDefined();
    await chatWebSocket.message(socket as any, JSON.stringify({ type: "tab_open_result", requestId: open.requestId, opened: true }));
    expect(await call).toMatchObject({ ok: true, result: { requestId: open.requestId, opened: true } });
  } finally {
    release();
    send.mockRestore();
    chatWebSocket.close(socket as any);
  }
});
