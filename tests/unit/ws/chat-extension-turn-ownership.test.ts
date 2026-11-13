/**
 * Whose turn is whose when an extension and a person write into the same chat. A turn has one
 * owner: an extension's budget and approval deadlines belong to the extension's own turn and to
 * nothing else, so they must never land on a person's turn, nor survive a person taking one over.
 */
import { afterEach, beforeAll, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatWebSocket, getSessionTurnOrigin, getSessionTurnState } from "../../../src/server/ws/chat.ts";
import { startHeadlessTurn } from "../../../src/server/ws/chat-headless-turn.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";

const provider = new QueuedTurnsProvider("turn-ownership");
beforeAll(() => providerRegistry.register(provider));
// Left registered: the registry has no unregister, and a provider nothing names is inert.

const sockets: any[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId, providerHint: provider.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  const say = (msg: unknown) => chatWebSocket.message(socket as any, JSON.stringify(msg));
  return { socket, messages, say, of: (type: string) => messages.filter((m) => m.type === type) };
}

it("a PPM builtin typed into a person's turn hands nothing to an extension message queued behind it", async () => {
  const session = await chatService.createSession(provider.id, {});
  const phone = connect(session.id);
  await phone.say({ type: "message", content: "hold:one" });
  await until(() => getSessionTurnState(session.id).running, "the person's turn to run");

  expect(await startHeadlessTurn(session.id, { content: "two", providerId: provider.id, timeoutMs: 200 })).toEqual({ queued: true });
  await phone.say({ type: "message", content: "/version" });
  // Past the queued message's budget: the person's turn is still running, and still theirs.
  await Bun.sleep(350);
  expect(getSessionTurnOrigin(session.id)).toBe("ws");
  expect(getSessionTurnState(session.id).running).toBe(true);
  expect(phone.of("error")).toHaveLength(0);
  provider.release(session.id);
  await until(() => !getSessionTurnState(session.id).running, "both turns to end");
});

it("refuses an extension message when the next turn already belongs to the person", async () => {
  const session = await chatService.createSession(provider.id, {});
  const phone = connect(session.id);
  await phone.say({ type: "message", content: "hold:one" });
  await until(() => getSessionTurnState(session.id).running, "the person's turn to run");
  await phone.say({ type: "message", content: "after this one", priority: "later" });

  await expect(startHeadlessTurn(session.id, { content: "two", providerId: provider.id })).rejects.toThrow("BUSY_QUEUED");
  expect(provider.pushes.some((p) => p.sessionId === session.id && p.content.includes("two"))).toBe(false);
  provider.release(session.id);
  await until(() => !getSessionTurnState(session.id).running, "the turns to end");
});

it("a person joining an extension's turn takes it over, budget and all", async () => {
  const session = await chatService.createSession(provider.id, {});
  const phone = connect(session.id);
  expect(await startHeadlessTurn(session.id, { content: "hold:one", providerId: provider.id, timeoutMs: 200 })).toEqual({ queued: false });
  await until(() => getSessionTurnState(session.id).running, "the extension's turn to run");
  expect(getSessionTurnOrigin(session.id)).toBe("extension");

  await phone.say({ type: "message", content: "let me take this" });
  expect(getSessionTurnOrigin(session.id)).toBe("ws");
  // The extension's 200 ms budget would have cut the turn by now; it is the person's turn.
  await Bun.sleep(350);
  expect(getSessionTurnState(session.id).running).toBe(true);
  expect(phone.of("error")).toHaveLength(0);
  provider.release(session.id);
  await until(() => !getSessionTurnState(session.id).running, "the turn to end");
});
