/**
 * A chat created on the server (the PPM Assistant's `chat_start`, another device) opens in a
 * tab whose metadata names no permission mode. The chip used to fall back to "Bypass
 * permissions" over a chat stored as "Ask before edits"; it now takes the stored mode from the
 * connect greeting, and the next message repeats that mode instead of replacing it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
installDom();
installGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");

const TAB = "stored-mode-tab";
let view: Mounted | null = null;
let receive: ((event: MessageEvent) => void) | undefined;
let send: ReturnType<typeof spyOn>;
const spies: Array<{ mockRestore(): void }> = [];

function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab tabId={TAB} metadata={metadata} />;
}
function openTab(metadata: Record<string, unknown>) {
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {},
    panels: { main: { id: "main", activeTabId: TAB, tabHistory: [TAB], tabs: [{ id: TAB, type: "chat", title: "Chat", projectId: "test", closable: true,
      metadata: { projectName: "test", sessionId: "s1", providerId: "claude", ...metadata } }] } } });
}
const meta = () => usePanelStore.getState().panels.main!.tabs[0]!.metadata!;
async function frame(data: unknown) { await act(async () => { receive!(new MessageEvent("message", { data: JSON.stringify(data) })); }); }
async function greet(fields: Record<string, unknown>) {
  await frame({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null, sessionTitle: null, ...fields });
}
function chip() { return view!.container.querySelector("button[aria-label^='Permission mode']")?.getAttribute("aria-label") ?? null; }
function input() { return view!.container.querySelector("textarea")!; }
async function typeAndSend(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
function sent() { return send.mock.calls.map(([value]) => JSON.parse(String(value))).filter((value) => value.type === "message"); }

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
  receive = undefined;
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/messages")) return Promise.resolve({ messages: [], versionMap: {} });
    if (path.includes("/drafts/")) return Promise.resolve(null);
    if (path.includes("/usage")) return Promise.resolve(null);
    return Promise.resolve([]);
  }), spyOn(api, "post").mockResolvedValue({}), spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined),
  spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
  spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => { receive = undefined; }; }));
  send = spyOn(WsClient.prototype, "send").mockImplementation(() => {}); spies.push(send);
});
afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
});

describe("ChatTab and the chat's stored permission mode", () => {
  it("shows the stored mode of a chat created on the server, and sending keeps it", async () => {
    openTab({});
    view = await mount(<Harness />);
    // Before the server has said, the chip guesses nothing — in particular not Bypass.
    expect(chip()).toBeNull();
    await greet({ permissionMode: "default", defaultPermissionMode: "bypassPermissions" });
    expect(chip()).toBe("Permission mode: Ask before edits");
    await typeAndSend("follow up");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ content: "follow up", permissionMode: "default" });
    expect(meta()).toMatchObject({ permissionMode: "default", permissionModeSource: "inherited" });
  });

  it("replaces a stale mode left in the tab's metadata with the stored one", async () => {
    openTab({ permissionMode: "bypassPermissions", permissionModeSource: "inherited" });
    view = await mount(<Harness />);
    await greet({ permissionMode: "plan", defaultPermissionMode: "bypassPermissions" });
    expect(chip()).toBe("Permission mode: Plan mode");
    await typeAndSend("go on");
    expect(sent()[0]!.permissionMode).toBe("plan");
  });

  it("with nothing stored, shows the server's default and sends no mode of its own", async () => {
    openTab({});
    view = await mount(<Harness />);
    await greet({ permissionMode: null, defaultPermissionMode: "acceptEdits" });
    expect(chip()).toBe("Permission mode: Edit automatically");
    await typeAndSend("hello");
    expect(sent()[0]).toMatchObject({ content: "hello" });
    expect(sent()[0]!.permissionMode).toBeUndefined();
  });

  it("a greeting without the field (a model switch) leaves the mode alone", async () => {
    openTab({});
    view = await mount(<Harness />);
    await greet({ permissionMode: "default", defaultPermissionMode: "bypassPermissions" });
    await greet({});
    expect(chip()).toBe("Permission mode: Ask before edits");
  });

  it("a reconnect does not undo a mode the user just picked for this chat", async () => {
    openTab({});
    view = await mount(<Harness />);
    await greet({ permissionMode: "default", defaultPermissionMode: "bypassPermissions" });
    await click(view.container.querySelector("button[aria-label^='Permission mode']"));
    await click([...view.container.querySelectorAll("[role='option']")].find((o) => o.textContent?.includes("Plan mode")) ?? null);
    expect(chip()).toBe("Permission mode: Plan mode");
    await greet({ permissionMode: "default", defaultPermissionMode: "bypassPermissions" });
    expect(chip()).toBe("Permission mode: Plan mode");
    await typeAndSend("plan it");
    expect(sent()[0]!.permissionMode).toBe("plan");
  });
});
