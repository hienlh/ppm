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
const { __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function prepareResult(overrides: Record<string, unknown> = {}) {
  return {
    resolvedProviderId: "codex", providerId: "codex",
    settings: { default_provider: "codex", new_chat_provider_mode: "follow-focus",
      providers: { codex: { permission_mode: "plan" }, claude: { permission_mode: "acceptEdits" } } },
    providers: [{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude" }],
    pickedAccount: { id: "codex-account", label: "Codex account" },
    usage: null, draft: null, tags: null, slash: null,
    ...overrides,
  };
}
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
let prepare: ReturnType<typeof deferred>;
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
  __clearPrepareForTest();
  sessionStorage.clear();
  // NewChatProviderGate now consults the real local cache synchronously (warm-restore
  // path) — a leftover write from an earlier test in this file must not resolve THIS
  // one's tab before its own mocked /chat/prepare gets a chance to answer.
  localStorage.clear();
  prepare = deferred(); claim = deferred(); create = deferred();
  receive = undefined;
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "early", tabHistory: ["early"],
      tabs: [{ id: "early", type: "chat", title: "Chat", projectId: "test", closable: true,
        metadata: { projectName: "test", providerPending: true, focusedProviderOnOpen: "codex" } }] } } });
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/usage")) return Promise.resolve(null);
    if (path.includes("/messages")) return Promise.resolve({ messages: [], versionMap: {} });
    return Promise.resolve([]);
  }));
  post = spyOn(api, "post").mockImplementation((path: string) => {
    if (path.endsWith("/chat/prepare")) return prepare.promise;
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
  __clearPrepareForTest();
  sessionStorage.clear();
  localStorage.clear();
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
function prepareCalls() { return post.mock.calls.filter(([path]) => String(path).endsWith("/chat/prepare")); }
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

it("queues an early greeting until prepare resolves the provider and its own account claim", async () => {
  view = await mount(<Harness />);
  const input = textarea();
  expect(input.disabled).toBe(false);
  expect(prepareCalls()).toHaveLength(1); // fired once, on mount, before any send
  await type("hello before preparation", true);
  expect(view.container.textContent).toContain("hello before preparation");
  expect(view.container.textContent).toContain("Starting conversation");
  expect(sessionCalls()).toHaveLength(0);
  await act(async () => { prepare.resolve(prepareResult()); });
  // Prepare's own pick already landed in metadata — handleSend must not also POST /pick.
  expect(pickCalls()).toHaveLength(0);
  expect(sessionCalls()).toHaveLength(1);
  expect(sessionCalls()[0]![1]).toMatchObject({ providerId: "codex", accountId: "codex-account" });
  expect(prepareCalls()).toHaveLength(1); // still exactly one — never re-fired by the send
  expect(messages()).toHaveLength(0);
  await act(async () => { create.resolve({ id: "first-session", providerId: "codex" }); });
  await connectSession();
  await connectSession();
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toMatchObject({ content: "hello before preparation", permissionMode: "plan" });
  expect(textarea()).toBe(input);
  expect(input.value).toBe("");
});

it("falls back to a POST /pick when prepare's own account claim times out", async () => {
  view = await mount(<Harness />);
  await type("hello", true);
  await act(async () => { prepare.resolve(prepareResult({ pickedAccount: "timeout" })); });
  expect(sessionCalls()).toHaveLength(0);
  expect(pickCalls()).toHaveLength(1);
  await act(async () => { claim.resolve({ id: "late-account", label: "Late account" }); });
  expect(sessionCalls()).toHaveLength(1);
  expect(sessionCalls()[0]![1]).toMatchObject({ providerId: "codex", accountId: "late-account" });
});

it("restores an early message if the resolved provider is unavailable, without creating a fallback session", async () => {
  view = await mount(<Harness />);
  await type("keep this message", true);
  await act(async () => { prepare.resolve(prepareResult({ providers: [{ id: "claude", name: "Claude" }] })); });
  expect(textarea().value).toBe("keep this message");
  expect(textarea().disabled).toBe(false);
  expect(view.container.textContent).toContain("codex is not available");
  expect(sessionCalls()).toHaveLength(0);
  expect(messages()).toHaveLength(0);
});

for (const erase of [false, true]) it(`does not overwrite ${erase ? "erased" : "typed"} text with a late draft`, async () => {
  view = await mount(<Harness />);
  await type("new typed text");
  if (erase) await type("");
  await act(async () => { prepare.resolve(prepareResult({ draft: { content: "old server draft", attachments: "[]", updatedAt: "" } })); });
  expect(textarea().value).toBe(erase ? "" : "new typed text");
  expect(sessionCalls()).toHaveLength(0);
});

for (const stage of ["preparation", "session creation"]) it(`does not send after unmount during ${stage}`, async () => {
  view = await mount(<Harness />);
  await type("closed tab message", true);
  if (stage === "session creation") {
    await act(async () => { prepare.resolve(prepareResult()); });
    expect(sessionCalls()).toHaveLength(1);
  }
  await view.unmount(); view = null;
  await act(async () => {
    prepare.resolve(prepareResult());
    create.resolve({ id: "first-session", providerId: "codex" });
  });
  expect(sessionCalls()).toHaveLength(stage === "preparation" ? 0 : 1);
  expect(messages()).toHaveLength(0);
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.sessionId).toBeUndefined();
});
