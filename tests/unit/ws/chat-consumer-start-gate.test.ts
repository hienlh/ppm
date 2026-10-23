/**
 * One consumer per session, whichever doors start it. A message that arrives while another
 * door is still resuming the session and starting the consumer — a typed message during an
 * extension's start, an extension's during a typed one, two extension calls in one tick —
 * waits for that consumer and reaches it as a follow-up: never a second consumer, never a
 * push into a stream that does not exist yet.
 */
import { afterEach, beforeAll, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatWebSocket, getSessionTurnState } from "../../../src/server/ws/chat.ts";
import { startHeadlessTurn } from "../../../src/server/ws/chat-headless-turn.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";

const provider = new QueuedTurnsProvider("gated-turns");
beforeAll(() => providerRegistry.register(provider));
// Left registered: the registry has no unregister, and a provider nothing names is inert.

const sockets: any[] = [];
afterEach(() => {
  provider.resumeHold = undefined;
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

function slowResume() {
  let release!: () => void;
  provider.resumeHold = new Promise<void>((resolve) => { release = resolve; });
  return release;
}

const queriesOf = (id: string) => provider.queries.filter((q) => q.sessionId === id);
const pushesOf = (id: string) => provider.pushes.filter((p) => p.sessionId === id);

it("a typed message during an extension's start is a follow-up on that consumer, not a second one", async () => {
  const session = await chatService.createSession(provider.id, {});
  const phone = connect(session.id);
  const release = slowResume();
  const starting = startHeadlessTurn(session.id, { content: "from the extension", providerId: provider.id });
  await Bun.sleep(10);
  expect(getSessionTurnState(session.id).running).toBe(true);
  const typed = phone.say({ type: "message", content: "typed meanwhile" });
  await Bun.sleep(20);
  expect(queriesOf(session.id)).toHaveLength(0);
  release();
  expect(await starting).toEqual({ queued: false });
  await typed;
  await until(() => pushesOf(session.id).length === 1, "the typed message to follow up");
  expect(queriesOf(session.id)).toHaveLength(1);
  expect(queriesOf(session.id)[0]!.message).toContain("from the extension");
  expect(pushesOf(session.id)[0]!.content).toContain("typed meanwhile");
  await until(() => phone.of("done").length === 2, "both turns to end");
});

it("an extension's message during a typed start waits for that consumer and reports queued", async () => {
  const session = await chatService.createSession(provider.id, {});
  const phone = connect(session.id);
  const release = slowResume();
  const typed = phone.say({ type: "message", content: "typed first" });
  await Bun.sleep(10);
  const pushed = startHeadlessTurn(session.id, { content: "from the extension", providerId: provider.id });
  await Bun.sleep(20);
  expect(queriesOf(session.id)).toHaveLength(0);
  release();
  await typed;
  expect(await pushed).toEqual({ queued: true });
  expect(queriesOf(session.id)).toHaveLength(1);
  expect(queriesOf(session.id)[0]!.message).toContain("typed first");
  expect(pushesOf(session.id).map((p) => p.content).some((c) => c.includes("from the extension"))).toBe(true);
  await until(() => phone.of("done").length === 2, "both turns to end");
});

it("two extension calls in one tick start one consumer; the second is its follow-up", async () => {
  const session = await chatService.createSession(provider.id, {});
  const [first, second] = await Promise.all([
    startHeadlessTurn(session.id, { content: "a", providerId: provider.id }),
    startHeadlessTurn(session.id, { content: "b", providerId: provider.id }),
  ]);
  expect([first.queued, second.queued].sort()).toEqual([false, true]);
  await until(() => pushesOf(session.id).length === 1, "the follow-up");
  expect(queriesOf(session.id)).toHaveLength(1);
  await until(() => !getSessionTurnState(session.id).running && pushesOf(session.id).length === 1, "idle");
});

it("a start that fails leaves the session idle for the next door", async () => {
  const session = await chatService.createSession(provider.id, {});
  const release = slowResume();
  const failing = startHeadlessTurn(session.id, { content: "a", providerId: provider.id });
  await Bun.sleep(5);
  provider.sessions.delete(session.id);
  release();
  await expect(failing).rejects.toThrow("not found");
  expect(getSessionTurnState(session.id)).toEqual({ running: false, phase: "idle" });
  provider.sessions.set(session.id, { id: session.id, providerId: provider.id, title: "T", createdAt: "" });
  expect(await startHeadlessTurn(session.id, { content: "b", providerId: provider.id })).toEqual({ queued: false });
  await until(() => !getSessionTurnState(session.id).running, "idle");
});
