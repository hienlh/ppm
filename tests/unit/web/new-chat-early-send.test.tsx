import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settings = { default_provider: "codex", new_chat_provider_mode: "follow-focus",
  providers: { codex: { permission_mode: "plan" }, claude: { permission_mode: "acceptEdits" } } };
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
let config: ReturnType<typeof deferred>;
let providers: ReturnType<typeof deferred>;
let draft: ReturnType<typeof deferred>;
let claim: ReturnType<typeof deferred>;
let create: ReturnType<typeof deferred>;
let post: ReturnType<typeof spyOn>;
let send: ReturnType<typeof spyOn>;
let receive: ((event: MessageEvent) => void) | undefined;

function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab tabId="early" metadata={metadata} />;
}

beforeEach(() => {
  clearChatPreparationCache();
  sessionStorage.clear();
  config = deferred(); providers = deferred(); draft = deferred(); claim = deferred(); create = deferred();
  receive = undefined;
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "early", tabHistory: ["early"],
      tabs: [{ id: "early", type: "chat", title: "Chat", projectId: "test", closable: true,
        metadata: { projectName: "test", providerPending: true, focusedProviderOnOpen: "codex" } }] } } });
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/drafts/__new__")) return draft.promise;
    if (path.includes("/drafts/")) return Promise.resolve(null);
    if (path === "/api/settings/ai") return config.promise;
    if (path.endsWith("/chat/providers")) return providers.promise;
    if (path.includes("/usage")) return Promise.resolve(null);
    if (path.includes("/messages")) return Promise.resolve({ messages: [], versionMap: {} });
    return Promise.resolve([]);
  }));
  post = spyOn(api, "post").mockImplementation((path: string) => {
    if (path.endsWith("/pick")) return claim.promise;
    if (path.endsWith("/chat/sessions")) return create.promise;
    throw new Error(`Unexpected POST: ${path}`);
  });
  send = spyOn(WsClient.prototype, "send").mockImplementation(() => {});
  spies.push(post, send, spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined),
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => { receive = undefined; }; }),
    spyOn(console, "error").mockImplementation(() => {}));
});

afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  clearChatPreparationCache();
  sessionStorage.clear();
});

function textarea() { return view!.container.querySelector("textarea")!; }
async function type(content: string, submit = false) {
  await act(async () => {
    const input = textarea();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, content);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (submit) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
async function resolvePreparation() {
  await act(async () => {
    config.resolve(settings);
    providers.resolve([{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude" }]);
  });
}
function sessionCalls() { return post.mock.calls.filter(([path]) => String(path).endsWith("/chat/sessions")); }
function pickCalls() { return post.mock.calls.filter(([path]) => String(path).endsWith("/pick")); }
function messages() { return send.mock.calls.map(([value]) => JSON.parse(String(value))).filter((value) => value.type === "message"); }
async function connectSession() {
  await act(async () => {
    receive!(new MessageEvent("message", { data: JSON.stringify({
      type: "session_state", sessionId: "first-session", phase: "idle", pendingApproval: null,
    }) }));
  });
}

it("queues an early greeting until the correct provider and shared account claim are ready", async () => {
  view = await mount(<Harness />);
  const input = textarea();
  expect(input).not.toBeNull();
  expect(input.disabled).toBe(false);
  expect(post).not.toHaveBeenCalled();
  await type("hello before preparation", true);
  expect(view.container.textContent).toContain("hello before preparation");
  expect(view.container.textContent).toContain("Starting conversation");
  expect(sessionCalls()).toHaveLength(0);
  expect(pickCalls()).toHaveLength(0);
  await resolvePreparation();
  expect(pickCalls()).toHaveLength(1);
  expect(pickCalls()[0]![0]).toBe("/api/codex-accounts/pick");
  expect(sessionCalls()).toHaveLength(0);
  await act(async () => { claim.resolve({ id: "codex-account", label: "Codex account" }); });
  expect(pickCalls()).toHaveLength(1);
  expect(sessionCalls()).toHaveLength(1);
  expect(sessionCalls()[0]![1]).toMatchObject({ providerId: "codex", accountId: "codex-account" });
  expect(messages()).toHaveLength(0);
  await act(async () => { create.resolve({ id: "first-session", providerId: "codex" }); });
  await connectSession();
  await connectSession();
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toMatchObject({ content: "hello before preparation", permissionMode: "plan" });
  expect(textarea()).toBe(input);
  expect(input.value).toBe("");
  await act(async () => { draft.resolve({ content: "old server draft", attachments: "[]" }); });
  expect(input.value).toBe("");
});

it("starts the session without an account when the account pick fails", async () => {
  view = await mount(<Harness />);
  await type("hello despite the pick", true);
  await resolvePreparation();
  expect(pickCalls()).toHaveLength(1);
  await act(async () => { claim.reject(new Error("Server error (HTTP 500)")); });
  expect(sessionCalls()).toHaveLength(1);
  expect(sessionCalls()[0]![1]).toMatchObject({ providerId: "codex", accountId: undefined });
  await act(async () => { create.resolve({ id: "first-session", providerId: "codex" }); });
  await connectSession();
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toMatchObject({ content: "hello despite the pick" });
});

it("restores an early message if its provider is unavailable without creating a fallback session", async () => {
  view = await mount(<Harness />);
  await type("keep this message", true);
  await act(async () => {
    config.resolve(settings);
    providers.resolve([{ id: "claude", name: "Claude" }]);
  });
  expect(textarea().value).toBe("keep this message");
  expect(textarea().disabled).toBe(false);
  expect(view.container.textContent).toContain("codex is not available");
  expect(post).not.toHaveBeenCalled();
  expect(messages()).toHaveLength(0);
});

it("restores an early message after preparation times out and ignores late settings", async () => {
  const originalTimeout = globalThis.setTimeout;
  const expire: Array<() => void> = [];
  spies.push(spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 30_000) { expire.push(callback); return 0; }
    return originalTimeout(callback, ms, ...args);
  }) as typeof setTimeout));
  view = await mount(<Harness />);
  await type("keep timed out text", true);
  await act(async () => { for (const callback of expire) callback(); });
  expect(textarea().value).toBe("keep timed out text");
  expect(textarea().disabled).toBe(false);
  expect(post).not.toHaveBeenCalled();
  await resolvePreparation();
  expect(post).not.toHaveBeenCalled();
  expect(messages()).toHaveLength(0);
});

for (const erase of [false, true]) it(`does not overwrite ${erase ? "erased" : "typed"} text with a late draft`, async () => {
  view = await mount(<Harness />);
  await type("new typed text");
  if (erase) await type("");
  await act(async () => { draft.resolve({ content: "old server draft", attachments: "[]" }); });
  expect(textarea().value).toBe(erase ? "" : "new typed text");
  expect(post).not.toHaveBeenCalled();
});

for (const stage of ["preparation", "session creation"]) it(`does not send after unmount during ${stage}`, async () => {
  view = await mount(<Harness />);
  await type("closed tab message", true);
  if (stage === "session creation") {
    await resolvePreparation();
    await act(async () => { claim.resolve({ id: "codex-account", label: null }); });
    expect(sessionCalls()).toHaveLength(1);
  }
  await view.unmount(); view = null;
  await resolvePreparation();
  await act(async () => {
    claim.resolve({ id: "codex-account", label: null });
    create.resolve({ id: "first-session", providerId: "codex" });
  });
  expect(sessionCalls()).toHaveLength(stage === "preparation" ? 0 : 1);
  expect(messages()).toHaveLength(0);
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.sessionId).toBeUndefined();
});
