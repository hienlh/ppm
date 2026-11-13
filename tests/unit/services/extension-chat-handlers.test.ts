/**
 * `ppm.chat.*` end to end on the main side: a real RpcChannel wired to the real handlers,
 * the mock provider scripted per test, and the extension socket driven with fake clients so
 * `chat:openTab` is addressed to the browser that ran the extension's command.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerExtensionChatHandlers } from "../../../src/services/extension-api/extension-chat-handlers.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getSessionModel, getSessionProjectPath } from "../../../src/services/db.service.ts";
import { contributionRegistry } from "../../../src/services/contribution-registry.ts";
import { extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import { listRunningSessions } from "../../../src/server/ws/chat.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

const PROJECT = "ext-chat-handlers-project";
const EXT = "probe-ext";
const PROJECT_PATH = `${process.cwd()}/.ext-chat-handlers-${process.pid}`;

const sent: RpcMessage[] = [];
const channel = new RpcChannel((msg) => sent.push(msg));
registerExtensionChatHandlers(channel);
let nextId = 1;

async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  await channel.handleMessage({ type: "request", id, method, params: [params] });
  const response = sent.find((m) => m.type === "response" && m.id === id) as RpcResponse | undefined;
  if (!response) throw new Error(`no response for ${method}`);
  if (response.error) throw new Error(response.error);
  return response.result as T;
}

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function scriptMock(events: (sessionId: string) => unknown[]) {
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string) {
    for (const event of events(sessionId)) yield event;
  } as never);
  restores.push(() => send.mockRestore());
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

beforeAll(() => {
  const projects = configService.get("projects").filter((p) => p.name !== PROJECT);
  configService.set("projects", [...projects, { name: PROJECT, path: PROJECT_PATH }]);
});

afterAll(() => {
  configService.set("projects", configService.get("projects").filter((p) => p.name !== PROJECT));
});

describe("chat:listProjects / chat:createSession", () => {
  it("lists registered projects and creates a session in one, storing the model", async () => {
    const projects = await call<{ name: string; path: string }[]>("chat:listProjects");
    expect(projects.some((p) => p.name === PROJECT && p.path === PROJECT_PATH)).toBe(true);

    const session = await call<{ sessionId: string; providerId: string; projectName: string }>("chat:createSession", {
      extensionId: EXT, projectName: PROJECT, providerId: "mock", title: "Night run", model: "claude-haiku-4-5",
    });
    expect(session.providerId).toBe("mock");
    expect(session.projectName).toBe(PROJECT);
    expect(chatService.getSession(session.sessionId)).not.toBeNull();
    expect(getSessionProjectPath(session.sessionId)).toBe(PROJECT_PATH);
    expect(getSessionModel(session.sessionId)).toBe("claude-haiku-4-5");
  });

  it("refuses an unregistered project and an unknown provider", async () => {
    await expect(call("chat:createSession", { extensionId: EXT, projectName: "nope", providerId: "mock" })).rejects.toThrow("not registered");
    await expect(call("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "no-such" })).rejects.toThrow("not found");
  });
});

describe("chat:send / chat:state / chat:lastAssistantText / chat:cancel", () => {
  it("starts a turn, reports it running, then idle, and reads the answer back", async () => {
    scriptMock((sid) => [{ type: "text", content: "all done" }, { type: "done", sessionId: sid }]);
    const { sessionId } = await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" });
    const provider = providerRegistry.get("mock")!;
    const messages = spyOn(provider, "getMessages").mockResolvedValue([
      { id: "u", role: "user", content: "go", timestamp: "" },
      { id: "a", role: "assistant", content: "all done", timestamp: "" },
    ] as never);
    restores.push(() => messages.mockRestore());

    const started = await call<{ sessionId: string; queued: boolean }>("chat:send", { extensionId: EXT, sessionId, content: "go", timeoutMs: 5_000 });
    expect(started).toEqual({ sessionId, queued: false });
    let state = await call<{ running: boolean; phase: string }>("chat:state", { sessionId });
    expect(state.running).toBe(true);
    await until(() => {
      void call<{ running: boolean; phase: string }>("chat:state", { sessionId }).then((s) => { state = s; });
      return !state.running;
    }, "the turn to end");
    expect(state).toEqual({ running: false, phase: "idle" });
    expect(await call("chat:lastAssistantText", { sessionId })).toBe("all done");
  });

  it("refuses what the REST route refuses, before anything starts", async () => {
    const { sessionId } = await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" });
    await expect(call("chat:send", { extensionId: EXT, sessionId, content: "   " })).rejects.toThrow("content is required");
    await expect(call("chat:send", { extensionId: EXT, sessionId, content: "hi", timeoutMs: 10 })).rejects.toThrow("timeoutMs");
    await expect(call("chat:send", { extensionId: EXT, sessionId: crypto.randomUUID(), content: "hi" })).rejects.toThrow("Session not found");
    await expect(call("chat:state", { sessionId: crypto.randomUUID() })).rejects.toThrow("Session not found");
  });

  it("cancel stops the turn through the chat service under the extension origin", async () => {
    const { sessionId } = await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" });
    const abort = spyOn(chatService, "abortQuery").mockImplementation(() => {});
    restores.push(() => abort.mockRestore());
    expect(await call("chat:cancel", { extensionId: EXT, sessionId })).toEqual({ cancelled: true });
    expect(abort).toHaveBeenCalledWith("mock", sessionId, "extension_cancel", "extension");
  });
});

describe("which sessions an extension may drive", () => {
  it("refuses to send to or stop a session another extension or a person created", async () => {
    const { sessionId } = await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" });
    await expect(call("chat:send", { extensionId: "someone-else", sessionId, content: "hi" })).rejects.toThrow("not created by this extension");
    await expect(call("chat:cancel", { extensionId: "someone-else", sessionId })).rejects.toThrow("not created by this extension");
    const theirs = await chatService.createSession("mock", { projectName: PROJECT, projectPath: PROJECT_PATH });
    await expect(call("chat:send", { extensionId: EXT, sessionId: theirs.id, content: "hi" })).rejects.toThrow("not created by this extension");
    await expect(call("chat:send", { sessionId, content: "hi" })).rejects.toThrow("extensionId is required");
  });

  it("caps the sessions one extension may have a turn in flight on, and frees a slot when a turn ends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const provider = providerRegistry.get("mock")!;
    const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string) {
      yield { type: "text", content: "working" };
      await held;
      yield { type: "done", sessionId };
    } as never);
    restores.push(() => send.mockRestore());
    const sessions: string[] = [];
    for (let i = 0; i < 5; i++) {
      sessions.push((await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" })).sessionId);
    }
    for (const sessionId of sessions.slice(0, 4)) {
      expect(await call("chat:send", { extensionId: EXT, sessionId, content: "go" })).toEqual({ sessionId, queued: false });
    }
    await expect(call("chat:send", { extensionId: EXT, sessionId: sessions[4]!, content: "go" })).rejects.toThrow("TOO_MANY_HEADLESS_TURNS");
    // A follow-up on a session already in flight is not a new slot.
    expect(await call("chat:send", { extensionId: EXT, sessionId: sessions[0]!, content: "more" })).toEqual({ sessionId: sessions[0], queued: true });
    release();
    await until(() => sessions.slice(0, 4).every((id) => !listRunningSessions().some((s) => s.sessionId === id)), "the four turns to end");
    expect(await call("chat:send", { extensionId: EXT, sessionId: sessions[4]!, content: "go" })).toEqual({ sessionId: sessions[4], queued: false });
    await until(() => !listRunningSessions().some((s) => s.sessionId === sessions[4]), "the fifth turn to end");
  });
});

describe("chat:openTab", () => {
  function fakeWs() {
    const messages: any[] = [];
    const ws = { data: { type: "extensions" }, send: (data: string) => { messages.push(JSON.parse(data)); }, messages };
    return ws;
  }

  it("opens nothing for a caller no browser ran a command for", async () => {
    const { sessionId } = await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" });
    expect(await call("chat:openTab", { sessionId, extensionId: "nobody-ran-me" })).toEqual({ opened: false });
  });

  it("addresses the tab to the browser that ran the extension's command, with the project in it", async () => {
    contributionRegistry.register(EXT, { commands: [{ command: "probe.run", title: "Run" }] } as never);
    const runner = fakeWs();
    const bystander = fakeWs();
    extensionWebSocket.open(runner as never);
    extensionWebSocket.open(bystander as never);
    try {
      await extensionWebSocket.message(runner as never, JSON.stringify({ type: "ready" }));
      const hello = runner.messages.find((m) => m.type === "client:hello");
      expect(typeof hello?.clientId).toBe("string");
      expect(runner.messages.map((m) => m.type)).toEqual(["client:hello", "contributions:update"]);
      await extensionWebSocket.message(runner as never, JSON.stringify({ type: "command:execute", command: "probe.run" }));

      const { sessionId, providerId } = await call<{ sessionId: string; providerId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock", title: "Graph" });
      expect(await call("chat:openTab", { sessionId, extensionId: EXT })).toEqual({ opened: true });

      const open = bystander.messages.find((m) => m.type === "tab:open");
      expect(open).toMatchObject({
        tabType: "chat", title: "Graph", projectId: PROJECT, clientId: hello.clientId,
        metadata: { projectName: PROJECT, sessionId, providerId },
      });
    } finally {
      extensionWebSocket.close(runner as never);
      extensionWebSocket.close(bystander as never);
      contributionRegistry.unregister(EXT);
    }
  });

  it("carries a window placement beside the calling panel, and none unless asked", async () => {
    contributionRegistry.register(EXT, { commands: [{ command: "probe.run", title: "Run" }] } as never);
    const runner = fakeWs();
    extensionWebSocket.open(runner as never);
    try {
      await extensionWebSocket.message(runner as never, JSON.stringify({ type: "ready" }));
      await extensionWebSocket.message(runner as never, JSON.stringify({ type: "command:execute", command: "probe.run" }));
      const { sessionId } = await call<{ sessionId: string }>("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "mock" });

      await call("chat:openTab", { sessionId, extensionId: EXT, placement: { preferWindow: true, besidePanelId: "probe-wv-1" } });
      await call("chat:openTab", { sessionId, extensionId: EXT, placement: { preferWindow: 1 } });
      const opens = runner.messages.filter((m) => m.type === "tab:open");
      expect(opens[0].placement).toEqual({ preferWindow: true, besidePanelId: "probe-wv-1" });
      expect("placement" in opens[1]).toBe(false);
    } finally {
      extensionWebSocket.close(runner as never);
      contributionRegistry.unregister(EXT);
    }
  });
});
