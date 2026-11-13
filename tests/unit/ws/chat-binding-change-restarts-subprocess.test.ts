/**
 * A live chat subprocess keeps the system prompt, tools and policy it was started with, so a
 * `bind` that changes them must restart it before the next turn — or the narrower policy an
 * extension just set would be reported by `getBinding` and not be in force. Idle: restarted
 * at once. A turn or background work running: left alone, restarted once the session is idle,
 * and the extension is told so.
 */
import { afterEach, beforeAll, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { backgroundShellRegistry } from "../../../src/services/background-shell-registry.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerExtensionApiHandlers, extensionApiDeps } from "../../../src/services/extension-api/index.ts";
import { bindSession, createBindableSession } from "../../../src/services/extension-session-binding.service.ts";
import { deleteExtension, setSessionPermissionMode } from "../../../src/services/db.service.ts";
import { chatWebSocket, getSessionTurnState } from "../../../src/server/ws/chat.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

const EXT = "restart-probe-ext";
const POLICY = { readRoots: ["/r"], writeRoots: ["/r/.proposals"] };
const provider = new QueuedTurnsProvider("binding-restart");
(provider as { supportsExtensionBinding?: boolean }).supportsExtensionBinding = true;
beforeAll(() => providerRegistry.register(provider));

const sent: RpcMessage[] = [];
const channel = new RpcChannel((msg) => sent.push(msg));
registerExtensionApiHandlers(channel, extensionApiDeps(1));
let nextId = 1;
async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  await channel.handleMessage({ type: "request", id, method, params: [params] });
  const response = sent.find((m) => m.type === "response" && m.id === id) as RpcResponse | undefined;
  if (!response) throw new Error(`no response for ${method}`);
  if (response.error) throw new Error(response.error);
  return response.result as T;
}
const bind = (sessionId: string, binding: unknown) => call<{ pendingRestart: boolean }>("chat:bind", { sessionId, extensionId: EXT, binding });

const sockets: any[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) chatWebSocket.close(socket); });

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId, providerHint: provider.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  return {
    messages,
    say: (content: string) => chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content })),
    done: () => messages.filter((m) => m.type === "done").length,
  };
}

async function liveBindableSession() {
  const session = await chatService.createSession(provider.id, {});
  createBindableSession(session.id, EXT);
  const tab = connect(session.id);
  return { id: session.id, tab };
}

const restarts = (sessionId: string) => provider.abortReasons.filter((a) => a.sessionId === sessionId && a.reason === "extension_binding").length;

/** The next message after a restart starts a query of its own, under the binding now stored. */
async function expectNextTurnUnderPolicy(sessionId: string, tab: ReturnType<typeof connect>) {
  await until(() => !provider.hasStreamingSession(sessionId) && !getSessionTurnState(sessionId).running, "the old subprocess to go");
  await Bun.sleep(20);
  const before = provider.queries.length;
  await tab.say("next");
  await until(() => provider.queries.length === before + 1, "a fresh query");
  expect(provider.queries.at(-1)?.opts).toMatchObject({ extensionToolPolicy: POLICY, permissionMode: "acceptEdits" });
}

it("restarts an idle subprocess at once, and not for a bind that changes nothing", async () => {
  const { id, tab } = await liveBindableSession();
  await tab.say("one");
  await until(() => tab.done() === 1 && !getSessionTurnState(id).running, "the first turn");
  expect(provider.hasStreamingSession(id)).toBe(true);

  expect(await bind(id, { toolPolicy: POLICY })).toMatchObject({ toolPolicy: POLICY, pendingRestart: false });
  expect(restarts(id)).toBe(1);
  await expectNextTurnUnderPolicy(id, tab);

  await until(() => tab.done() === 2, "the second turn");
  expect(await bind(id, { toolPolicy: POLICY })).toMatchObject({ pendingRestart: false });
  expect(restarts(id)).toBe(1);
});

it("waits for a running turn to end, then restarts", async () => {
  const { id, tab } = await liveBindableSession();
  await tab.say("hold:one");
  await until(() => getSessionTurnState(id).running && provider.hasStreamingSession(id), "the turn to run");

  expect(await bind(id, { toolPolicy: POLICY })).toMatchObject({ pendingRestart: true });
  expect(restarts(id)).toBe(0);
  provider.release(id);
  await until(() => restarts(id) === 1, "the restart once the turn ended");
  await expectNextTurnUnderPolicy(id, tab);
});

it("never kills background work for it: the restart waits for an idle moment without any", async () => {
  const { id, tab } = await liveBindableSession();
  await tab.say("one");
  await until(() => tab.done() === 1 && !getSessionTurnState(id).running, "the first turn");
  backgroundShellRegistry.register(id, { shellId: "sh-1", command: "bun test --watch", outputPath: "/tmp/out", toolUseId: "tu-1" });
  try {
    expect(await call<{ pendingRestart: boolean }>("chat:unbind", { sessionId: id, extensionId: EXT })).toMatchObject({ pendingRestart: false });
    expect(await bind(id, { toolPolicy: POLICY })).toMatchObject({ pendingRestart: true });
    expect(restarts(id)).toBe(0);
    // A turn ending while the shell still runs does not restart either.
    await tab.say("two");
    await until(() => tab.done() === 2, "the second turn");
    await Bun.sleep(20);
    expect(restarts(id)).toBe(0);
  } finally {
    backgroundShellRegistry.clearSession(id);
  }
  await tab.say("three");
  await until(() => restarts(id) === 1, "the restart at the first idle moment with no background work");
  await expectNextTurnUnderPolicy(id, tab);
});

it("tells the tab the mode a policy chat really runs in, which the picker does not show", async () => {
  const session = await chatService.createSession(provider.id, {});
  createBindableSession(session.id, EXT);
  bindSession(session.id, EXT, { toolPolicy: POLICY });
  setSessionPermissionMode(session.id, "bypassPermissions");
  expect(connect(session.id).messages.find((m) => m.type === "session_state")?.boundPermissionMode).toBe("acceptEdits");
  setSessionPermissionMode(session.id, "plan");
  expect(connect(session.id).messages.find((m) => m.type === "session_state")?.boundPermissionMode).toBe("acceptEdits");

  const plain = await chatService.createSession(provider.id, {});
  expect(connect(plain.id).messages.find((m) => m.type === "session_state")?.boundPermissionMode).toBeNull();
});

it("refuses a message typed into a chat whose extension was removed, and says why", async () => {
  const session = await chatService.createSession(provider.id, {});
  createBindableSession(session.id, "removed-later-ext");
  bindSession(session.id, "removed-later-ext", { toolPolicy: POLICY });
  const tab = connect(session.id);
  await tab.say("one");
  await until(() => tab.done() === 1 && !getSessionTurnState(session.id).running, "the first turn");

  deleteExtension("removed-later-ext");
  const pushes = provider.pushes.length;
  await tab.say("two");
  await until(() => tab.messages.some((m) => m.type === "error"), "the refusal");
  expect(tab.messages.find((m) => m.type === "error")?.message).toContain("The extension that managed this chat (removed-later-ext) was removed");
  expect(provider.pushes.length).toBe(pushes);
});
