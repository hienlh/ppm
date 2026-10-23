/**
 * A message an extension pushes while a person's turn runs is queued as a turn of its own.
 * The person's turn keeps everything that is theirs — the approval they are being asked for,
 * the card staying up when they close the tab, the "Chat completed" push — and the extension's
 * origin, budget and auto-deny apply only from the moment its queued turn starts.
 */
import { afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { notificationService } from "../../../src/services/notification.service.ts";
import { chatWebSocket, getSessionTurnOrigin, getSessionTurnState, setExtensionApprovalDeadlineMs } from "../../../src/server/ws/chat.ts";
import { startHeadlessTurn } from "../../../src/server/ws/chat-headless-turn.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";

const provider = new QueuedTurnsProvider("queued-turns");
beforeAll(() => providerRegistry.register(provider));
// Left registered: the registry has no unregister, and a provider nothing names is inert.

const restores: Array<() => void> = [];
const sockets: any[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  for (const restore of restores.splice(0)) restore();
  setExtensionApprovalDeadlineMs(null);
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId, providerHint: provider.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  const say = (msg: unknown) => chatWebSocket.message(socket as any, JSON.stringify(msg));
  return { socket, messages, say, of: (type: string) => messages.filter((m) => m.type === type) };
}

function captureNotifications() {
  const sent: { type: string; payload: any }[] = [];
  const spy = spyOn(notificationService, "broadcast").mockImplementation(((type: string, payload: unknown) => { sent.push({ type, payload }); }) as never);
  restores.push(() => spy.mockRestore());
  return sent;
}

it("leaves a person's running turn alone, then runs the queued turn as the extension's with its budget", async () => {
  setExtensionApprovalDeadlineMs(60);
  const sent = captureNotifications();
  const session = await chatService.createSession(provider.id, {});
  const phone = connect(session.id);

  // The person's turn: an approval they are being asked for, an error, then a wait before done.
  await phone.say({ type: "message", content: "ask:err:hold:one" });
  await until(() => phone.of("approval_request").length === 1, "the person's approval card");
  expect(getSessionTurnOrigin(session.id)).toBe("ws");

  // The extension pushes behind it: queued, and nothing about the running turn changes.
  const pushed = await startHeadlessTurn(session.id, { content: "ask:hold:two", providerId: provider.id, timeoutMs: 300 });
  expect(pushed).toEqual({ queued: true });
  expect(provider.pushes.map((p) => p.content).some((c) => c.includes("ask:hold:two"))).toBe(true);
  expect(getSessionTurnOrigin(session.id)).toBe("ws");
  // Past the extension deadline: the person's approval is still theirs to answer.
  await Bun.sleep(120);
  expect(provider.approvalAnswers).toHaveLength(0);
  expect(phone.of("approval_resolved")).toHaveLength(0);
  // Closing the tab does not deny it either, as it would for an extension's turn.
  chatWebSocket.close(phone.socket);
  sockets.splice(sockets.indexOf(phone.socket), 1);
  await Bun.sleep(30);
  expect(provider.approvalAnswers).toHaveLength(0);

  // The person comes back and answers; their turn ends with its "Chat completed" push.
  const again = connect(session.id);
  expect(again.of("session_state")[0].pendingApproval?.requestId).toBe("req-1");
  await again.say({ type: "approval_response", requestId: "req-1", approved: true });
  expect(provider.approvalAnswers).toEqual([{ requestId: "req-1", approved: true }]);
  await until(() => getSessionTurnState(session.id).lastError === "the turn hit an error", "the person's turn to report its error");
  expect(getSessionTurnOrigin(session.id)).toBe("ws");
  provider.release(session.id);
  await until(() => again.of("done").length === 1, "the person's turn to end");
  await until(() => sent.some((n) => n.type === "done"), "the completion push");
  chatWebSocket.close(again.socket);
  sockets.splice(sockets.indexOf(again.socket), 1);

  // The queued turn starts: the extension's from here, its error slate clean, unattended —
  // so its own approval is denied at once — and its wall-clock budget ends it.
  await until(() => getSessionTurnOrigin(session.id) === "extension", "the extension's turn to start");
  expect(getSessionTurnState(session.id).lastError).toBeUndefined();
  await until(() => provider.approvalAnswers.length === 2, "the extension's approval to be denied");
  expect(provider.approvalAnswers[1]).toEqual({ requestId: "req-2", approved: false });
  await until(() => provider.abortReasons.some((a) => a.sessionId === session.id && a.reason === "headless_timeout"), "the budget");
  await until(() => !getSessionTurnState(session.id).running, "the session to go idle");
  expect(sent.filter((n) => n.type === "done")).toHaveLength(1);
});

it("a follow-up on an idle session opens the extension's turn at once, with its budget armed after the push", async () => {
  const session = await chatService.createSession(provider.id, {});
  await startHeadlessTurn(session.id, { content: "one", providerId: provider.id });
  await until(() => !getSessionTurnState(session.id).running && provider.hasStreamingSession(session.id), "the first turn");

  const pushed = await startHeadlessTurn(session.id, { content: "hold:two", providerId: provider.id, timeoutMs: 200 });
  expect(pushed).toEqual({ queued: true });
  expect(getSessionTurnOrigin(session.id)).toBe("extension");
  expect(getSessionTurnState(session.id).running).toBe(true);
  await until(() => provider.abortReasons.some((a) => a.sessionId === session.id && a.reason === "headless_timeout"), "the budget");
  await until(() => !getSessionTurnState(session.id).running, "idle");
});
