import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear();
});

for (const outcome of ["failure", "connected", "connection timeout", "reload"] as const) it(`keeps first-send progress until ${outcome}`, async () => {
  spies.push(spyOn(api, "get").mockImplementation(async (path: string) => {
    if (path.includes("/drafts/")) return null;
    if (path.includes("/settings/ai")) return { providers: {} };
    if (path.includes("/usage")) return null;
    if (path.includes("/messages")) return { messages: [], versionMap: {} };
    return [];
  }));
  let rejectCreate!: (error: Error) => void;
  let resolveCreate!: (value: unknown) => void;
  let receive!: (event: MessageEvent) => void;
  let expireConnection!: () => void;
  const realSetTimeout = globalThis.setTimeout;
  spies.push(spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 45_000) expireConnection = callback;
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout));
  spies.push(spyOn(WsClient.prototype, "connect").mockImplementation(() => {}));
  spies.push(spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }));
  const send = spyOn(WsClient.prototype, "send").mockImplementation(() => {});
  spies.push(send);
  const post = spyOn(api, "post").mockImplementation(() => new Promise((resolve, reject) => { resolveCreate = resolve; rejectCreate = reject; }));
  spies.push(post, spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined));
  view = await mount(<ChatTab metadata={{ projectName: "test", permissionMode: "bypassPermissions" }} />);
  const textarea = view.container.querySelector("textarea")!;
  expect(textarea).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "hello");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(post).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).not.toContain("Send a message to start a new conversation");
  expect(view.container.textContent).toContain("Starting conversation");
  expect(textarea.disabled).toBe(true);
  if (outcome === "reload") {
    // A recovering server or a 401 reloads the app before the pending POST
    // settles. The debounced server draft has not been saved yet.
    await view.unmount();
    view = await mount(<ChatTab metadata={{ projectName: "test", permissionMode: "bypassPermissions" }} />);
    expect(view.container.querySelector("textarea")!.value).toBe("hello");
    expect(post).toHaveBeenCalledTimes(1); // Never automatically resend.
    return;
  }
  if (outcome === "failure") {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    spies.push(errors);
    await act(async () => { rejectCreate(new Error("offline")); });
    expect(textarea.value).toBe("hello");
    expect(errors).toHaveBeenCalled();
  } else {
    await act(async () => { resolveCreate({ id: "first-session", providerId: "claude" }); });
    expect(view.container.textContent).toContain("Starting conversation");
    expect(send).not.toHaveBeenCalled();
    if (outcome === "connection timeout") {
      await act(async () => { expireConnection(); });
      expect(textarea.value).toBe("hello");
      expect(send).not.toHaveBeenCalled();
    } else {
      await act(async () => {
      receive(new MessageEvent("message", { data: JSON.stringify({
        type: "session_state", sessionId: "first-session", phase: "idle", pendingApproval: null,
      }) }));
      });
      expect(send.mock.calls.some(([data]) => JSON.parse(String(data)).content === "hello")).toBe(true);
      expect(view.container.textContent).toContain("hello");
      expect(view.container.textContent).not.toContain("Send a message to start a new conversation");
    }
  }
  expect(view.container.textContent).not.toContain("Starting conversation");
  expect(textarea.disabled).toBe(false);
});
