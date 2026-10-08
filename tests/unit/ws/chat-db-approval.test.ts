import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { dbApprovalBroker } from "../../../src/services/db-ai-tools/db-approval-broker.ts";

const INPUT = {
  connectionId: 7, connectionName: "Prod", dbType: "postgres" as const, group: null, color: null, readonly: true,
  sql: "DELETE FROM jobs WHERE id = 1", reason: "Drop the stuck job",
};

/** A chat whose turn is under way until `release`, and a way to connect devices to it. */
async function turnInProgress(events: unknown[] = []) {
  const session = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    for (const ev of events) yield ev as any;
    await gate;
  });
  const sockets: any[] = [];
  const connect = () => {
    const messages: any[] = [];
    const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages, of: (type: string) => messages.filter((m) => m.type === type) };
  };
  const say = (socket: unknown, msg: unknown) => chatWebSocket.message(socket as any, JSON.stringify(msg));
  const phone = connect();
  await say(phone.socket, { type: "message", content: "fix the stuck job" });
  for (let i = 0; i < 100 && !phone.messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
  const done = () => {
    release();
    send.mockRestore();
    for (const socket of sockets) chatWebSocket.close(socket);
  };
  return { session, phone, connect, say, done };
}

it("shows a database change on every device, holds it for one that connects later, and only an HTTP answer settles it", async () => {
  const { session, phone, connect, say, done } = await turnInProgress();
  try {
    const desktop = connect();
    const outcome = dbApprovalBroker.request(session.id, INPUT, 5_000);
    const [shown] = phone.of("approval_request");
    expect(shown).toMatchObject({ tool: "ppm:db_execute", input: { ...INPUT, passwordRequired: false } });
    expect(desktop.of("approval_request")).toHaveLength(1);

    const late = connect();
    expect(late.of("session_state")[0].pendingApproval.requestId).toBe(shown.requestId);
    const replay = late.of("turn_events")[0];
    expect(replay.events.some((e: any) => e.type === "approval_request")).toBe(false);

    // The chat socket's Allow, which carries no password, cannot approve it.
    await say(desktop.socket, { type: "approval_response", requestId: shown.requestId, approved: true });
    expect(dbApprovalBroker.has(shown.requestId)).toBe(true);

    expect(dbApprovalBroker.answer(shown.requestId, { approved: true })).toEqual({ ok: true, approved: true });
    expect(await outcome).toEqual({ approved: true });
    for (const device of [phone, desktop, late]) {
      expect(device.of("approval_resolved")).toEqual([{ type: "approval_resolved", requestId: shown.requestId, approved: true, answers: null }]);
    }
    expect(connect().of("session_state")[0].pendingApproval).toBeNull();
  } finally {
    done();
  }
});

it("declines a waiting change when the user sends a message instead, or stops the chat", async () => {
  const { session, phone, say, done } = await turnInProgress();
  try {
    const first = dbApprovalBroker.request(session.id, INPUT, 5_000);
    await say(phone.socket, { type: "message", content: "no, do it differently" });
    expect(await first).toMatchObject({ approved: false, reason: "cancelled", message: "The user sent a message instead of approving, so nothing ran." });

    const second = dbApprovalBroker.request(session.id, INPUT, 5_000);
    await say(phone.socket, { type: "cancel" });
    expect(await second).toMatchObject({ approved: false, reason: "cancelled", message: "The user stopped the chat before approving, so nothing ran." });
    expect(dbApprovalBroker.pendingCount()).toBe(0);
  } finally {
    done();
  }
});

it("waits behind a provider's own approval rather than taking its card away", async () => {
  const providerAsk = { type: "approval_request", requestId: "provider-1", tool: "Bash", input: { command: "ls" } };
  const { session, phone, say, done } = await turnInProgress([providerAsk]);
  try {
    for (let i = 0; i < 100 && phone.of("approval_request").length === 0; i++) await Bun.sleep(5);
    const outcome = dbApprovalBroker.request(session.id, INPUT, 5_000);
    expect(phone.of("approval_request").map((m) => m.requestId)).toEqual(["provider-1"]);

    await say(phone.socket, { type: "approval_response", requestId: "provider-1", approved: true });
    const shown = phone.of("approval_request").at(-1);
    expect(shown).toMatchObject({ tool: "ppm:db_execute" });
    dbApprovalBroker.answer(shown.requestId, { approved: false });
    expect(await outcome).toMatchObject({ approved: false, reason: "declined" });
  } finally {
    done();
  }
});
