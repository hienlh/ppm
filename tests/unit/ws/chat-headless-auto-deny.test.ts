/**
 * An extension's turn has no person behind it. Its approvals — the provider's own, a question,
 * a `db_execute` — are denied at once while no browser is attached, and after the deadline
 * while one is; a browser peeking at the turn does not make it a person's turn; and the turn's
 * end marks the chat unread without pushing "Chat completed" unless the extension asked.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { notificationService } from "../../../src/services/notification.service.ts";
import { dbApprovalBroker } from "../../../src/services/db-ai-tools/db-approval-broker.ts";
import { getSessionUnreadCount } from "../../../src/services/db.service.ts";
import { traceWriter } from "../../../src/services/session-trace/trace-writer.ts";
import { readSessionTimeline } from "../../../src/services/session-trace/session-trace-store.ts";
import { chatWebSocket, getSessionTurnOrigin, listRunningSessions, setExtensionApprovalDeadlineMs } from "../../../src/server/ws/chat.ts";
import { startHeadlessTurn } from "../../../src/server/ws/chat-headless-turn.ts";

const running = (id: string) => listRunningSessions().some((s) => s.sessionId === id);

const DB_INPUT = {
  connectionId: 7, connectionName: "Prod", dbType: "postgres" as const, group: null, color: null, readonly: true,
  sql: "DELETE FROM jobs WHERE id = 1", reason: "Drop the stuck job",
};

const restores: Array<() => void> = [];
const sockets: any[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  for (const restore of restores.splice(0)) restore();
  setExtensionApprovalDeadlineMs(null);
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  return { socket, messages, of: (type: string) => messages.filter((m) => m.type === type) };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A gate the scripted provider waits at; `open()` lets the script go on. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

function script(run: (sessionId: string) => AsyncGenerator<unknown>) {
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation(((sessionId: string) => run(sessionId)) as never);
  restores.push(() => send.mockRestore());
}

function captureNotifications() {
  const sent: { type: string; payload: any }[] = [];
  const spy = spyOn(notificationService, "broadcast").mockImplementation(((type: string, payload: unknown) => { sent.push({ type, payload }); }) as never);
  restores.push(() => spy.mockRestore());
  return sent;
}

function captureApprovals() {
  const calls: unknown[][] = [];
  const spy = spyOn(chatService, "resolveApproval").mockImplementation(((...args: unknown[]) => { calls.push(args); }) as never);
  restores.push(() => spy.mockRestore());
  return calls;
}

const ask = (requestId: string) => ({ type: "approval_request", requestId, tool: "Bash", input: { command: "rm -rf build" } });

it("denies an approval at once with no device attached, sets no unread or push, and replays an answered card", async () => {
  const session = await chatService.createSession("mock", {});
  const hold = gate();
  script(async function* (sid) {
    yield { type: "text", content: "working" };
    yield ask("req-1");
    await hold.opened;
    yield { type: "done", sessionId: sid };
  });
  const sent = captureNotifications();
  const approvals = captureApprovals();

  await startHeadlessTurn(session.id, { content: "clean up", providerId: "mock" });
  await until(() => approvals.length > 0, "the denial");
  expect(approvals[0]).toEqual(["mock", session.id, "req-1", false, undefined, { reason: "extension_turn_unattended", origin: "extension" }]);
  expect(getSessionUnreadCount(session.id)).toBe(0);
  expect(sent.filter((n) => n.type === "approval_request")).toHaveLength(0);

  const late = connect(session.id);
  const replay = late.of("turn_events")[0];
  const types = replay.events.map((e: any) => e.type);
  const askAt = types.indexOf("approval_request");
  expect(replay.events[askAt]).toMatchObject({ requestId: "req-1", approved: false });
  expect(replay.events[askAt + 1]).toMatchObject({ type: "approval_resolved", requestId: "req-1", approved: false });
  expect(late.of("session_state")[0].pendingApproval).toBeNull();
  hold.open();
  await until(() => late.of("done").length > 0, "the turn to end");
});

it("holds the approval for an attached device, then denies it at the deadline", async () => {
  setExtensionApprovalDeadlineMs(60);
  const session = await chatService.createSession("mock", {});
  const hold = gate();
  script(async function* (sid) {
    yield { type: "text", content: "working" };
    yield ask("req-2");
    await hold.opened;
    yield { type: "done", sessionId: sid };
  });
  const approvals = captureApprovals();
  const phone = connect(session.id);

  await startHeadlessTurn(session.id, { content: "clean up", providerId: "mock" });
  await until(() => phone.of("approval_request").length > 0, "the card");
  expect(approvals).toHaveLength(0);
  expect(getSessionTurnOrigin(session.id)).toBe("extension");

  await until(() => approvals.length > 0, "the deadline");
  expect(approvals[0]).toEqual(["mock", session.id, "req-2", false, undefined, { reason: "extension_approval_deadline", origin: "extension" }]);
  expect(phone.of("approval_resolved")).toEqual([{ type: "approval_resolved", requestId: "req-2", approved: false, answers: null }]);
  expect(connect(session.id).of("session_state")[0].pendingApproval).toBeNull();
  hold.open();
  await until(() => phone.of("done").length > 0, "the turn to end");
});

it("keeps the turn an extension's through a peek, so the next approval is still denied unattended", async () => {
  const session = await chatService.createSession("mock", {});
  const first = gate();
  const second = gate();
  script(async function* (sid) {
    yield { type: "text", content: "working" };
    await first.opened;
    yield ask("req-3");
    await second.opened;
    yield { type: "done", sessionId: sid };
  });
  const approvals = captureApprovals();

  await startHeadlessTurn(session.id, { content: "clean up", providerId: "mock" });
  await until(() => getSessionTurnOrigin(session.id) === "extension", "the turn to start");
  const peek = connect(session.id);
  await until(() => peek.of("turn_events").length > 0 || peek.of("text").length > 0, "the replay");
  chatWebSocket.close(peek.socket);
  expect(getSessionTurnOrigin(session.id)).toBe("extension");

  first.open();
  await until(() => approvals.length > 0, "the denial");
  expect(approvals[0]?.[5]).toEqual({ reason: "extension_turn_unattended", origin: "extension" });
  second.open();
  await until(() => !running(session.id), "the turn to end");
});

it("lets the database broker settle a db_execute unattended, with nothing pending and no timer", async () => {
  const session = await chatService.createSession("mock", {});
  const hold = gate();
  script(async function* (sid) {
    yield { type: "text", content: "working" };
    await hold.opened;
    yield { type: "done", sessionId: sid };
  });
  await startHeadlessTurn(session.id, { content: "fix the job", providerId: "mock" });
  await until(() => getSessionTurnOrigin(session.id) === "extension", "the turn to start");

  const outcome = await dbApprovalBroker.request(session.id, DB_INPUT, 5_000);
  expect(outcome).toMatchObject({ approved: false, reason: "no-chat" });
  expect(dbApprovalBroker.pendingCount()).toBe(0);
  expect(dbApprovalBroker.pendingEvent(session.id)).toBeNull();
  hold.open();
});

it("shows a db_execute to an attached device and cancels it at the deadline", async () => {
  setExtensionApprovalDeadlineMs(60);
  const session = await chatService.createSession("mock", {});
  const hold = gate();
  script(async function* (sid) {
    yield { type: "text", content: "working" };
    await hold.opened;
    yield { type: "done", sessionId: sid };
  });
  const phone = connect(session.id);
  await startHeadlessTurn(session.id, { content: "fix the job", providerId: "mock" });
  await until(() => phone.of("text").length > 0, "the turn to start");

  const outcome = dbApprovalBroker.request(session.id, DB_INPUT, 5_000);
  await until(() => phone.of("approval_request").length > 0, "the card");
  expect(await outcome).toMatchObject({ approved: false, reason: "cancelled" });
  expect(phone.of("approval_resolved")).toHaveLength(1);
  hold.open();
});

it("marks the chat unread at the end but pushes no completion unless asked, and traces the origin", async () => {
  const session = await chatService.createSession("mock", {});
  script(async function* (sid) {
    yield { type: "text", content: "finished" };
    yield { type: "done", sessionId: sid };
  });
  const sent = captureNotifications();
  const watcher = connect(session.id);

  await startHeadlessTurn(session.id, { content: "first", providerId: "mock" });
  await until(() => watcher.of("done").length === 1, "the first turn");
  expect(getSessionUnreadCount(session.id)).toBeGreaterThan(0);
  await Bun.sleep(20);
  expect(sent.filter((n) => n.type === "done")).toHaveLength(0);

  await until(() => !running(session.id), "idle");
  await startHeadlessTurn(session.id, { content: "second", providerId: "mock", notifyOnDone: true });
  await until(() => sent.some((n) => n.type === "done"), "the completion push");
  expect(sent.find((n) => n.type === "done")!.payload.sessionId).toBe(session.id);

  traceWriter.flush();
  const origins = new Set(readSessionTimeline(session.id).map((e) => e.origin));
  expect(origins.has("extension")).toBe(true);
  expect(origins.has("ws")).toBe(false);
});
