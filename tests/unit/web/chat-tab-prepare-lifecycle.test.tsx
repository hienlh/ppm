/**
 * How a chat tab's `/chat/prepare` behaves over the tab's life, not just at its first
 * mount: re-renders and remounts must not prepare again (each prepare may consume an
 * account), a tab that got a session must never join its old answer, and the fresh
 * permission from prepare may only replace a cached default — never a mode the user
 * picked or one the tab kept from a session it already ran (a design tab's `/clear`).
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { patchTabMetadata } = await import("../../../src/web/lib/patch-tab-metadata");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const {
  isPrepared, getPrepare, __clearPrepareForTest, __setPrepareTransportForTest, __expirePrepareJoinForTest,
} = await import("../../../src/web/lib/new-chat-prepare-client");

const TAB = "lifecycle";
type Answer = (value: unknown) => void;
let answers: Answer[] = [];
let bodies: unknown[] = [];
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];

function prepared(permission: string, overrides: Record<string, unknown> = {}) {
  return {
    resolvedProviderId: "claude", providerId: "claude",
    settings: { default_provider: "claude", providers: { claude: { permission_mode: permission } } },
    providers: [{ id: "claude", name: "Claude" }],
    pickedAccount: "skipped", usage: null, draft: null, tags: null, slash: null,
    ...overrides,
  };
}

/** Mirrors the design pane: the chat is keyed on the tab's chat epoch. */
function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab key={String(metadata.designChatEpoch ?? 0)} tabId={TAB} metadata={metadata} />;
}

function openTab(metadata: Record<string, unknown>) {
  usePanelStore.setState({ currentProject: "life", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: TAB, tabHistory: [TAB],
      tabs: [{ id: TAB, type: "chat", title: "Chat", projectId: "life", closable: true,
        metadata: { projectName: "life", providerId: "claude", ...metadata } }] } } });
}
const meta = () => usePanelStore.getState().panels.main!.tabs[0]!.metadata!;
async function patch(values: Record<string, unknown>) { await act(async () => { patchTabMetadata(TAB, values); }); }
async function answer(index: number, value: unknown) { await act(async () => { answers[index]!(value); }); }
function textarea() { return view!.container.querySelector("textarea")!; }

beforeEach(() => {
  clearChatPreparationCache();
  __clearPrepareForTest();
  sessionStorage.clear();
  localStorage.clear();
  answers = []; bodies = [];
  __setPrepareTransportForTest(((_path, body) => {
    bodies.push(body);
    return new Promise((resolve) => { answers.push(resolve as Answer); });
  }) as Parameters<typeof __setPrepareTransportForTest>[0]);
  spies.push(
    spyOn(api, "get").mockImplementation((path: string) => {
      if (path.includes("/usage")) return Promise.resolve(null);
      if (path.includes("/messages")) return Promise.resolve({ messages: [], versionMap: {} });
      if (path.includes("/drafts/")) return Promise.resolve(null);
      return Promise.resolve([]);
    }),
    spyOn(api, "post").mockImplementation((path: string) => Promise.reject(new Error(`Unexpected POST: ${path}`))),
    spyOn(api, "put").mockImplementation(() => Promise.resolve({})),
    spyOn(api, "del").mockImplementation(() => Promise.resolve(undefined)),
    spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation(() => () => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  );
});

afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  __setPrepareTransportForTest(null);
  __clearPrepareForTest();
  clearChatPreparationCache();
  sessionStorage.clear();
  localStorage.clear();
});

it("prepares once per tab: never again on a re-render, nor on a remount after the join window", async () => {
  openTab({ permissionMode: "bypassPermissions", permissionModeSource: "cache" });
  view = await mount(<Harness />);
  expect(bodies).toHaveLength(1);
  await answer(0, prepared("bypassPermissions"));
  for (let n = 0; n < 3; n++) await patch({ unrelated: n });
  // The client forgets its answer 30 s after it settled; a render after that used to re-POST.
  __expirePrepareJoinForTest(TAB);
  await patch({ unrelated: "after the window" });
  await patch({ designChatEpoch: 1 }); // remount under the same tab id
  expect(bodies).toHaveLength(1);
  expect(isPrepared(TAB)).toBe(true);
});

it("skips the pick when the tab already holds a claim for its provider", async () => {
  openTab({ pickedAccountId: "acct", pickedAccountLabel: "Acct", pickedAccountProvider: "claude" });
  view = await mount(<Harness />);
  expect(bodies[0]).toMatchObject({ providerId: "claude", skipPick: true });
});

it("replaces a cached default with the fresh permission", async () => {
  openTab({ permissionMode: "bypassPermissions", permissionModeSource: "cache" });
  view = await mount(<Harness />);
  await answer(0, prepared("acceptEdits"));
  expect(meta()).toMatchObject({ permissionMode: "acceptEdits", permissionModeSource: "cache" });
});

for (const [label, carried] of [
  ["a mode the user picked", { permissionMode: "default", permissionModeSource: "user" }],
  ["a mode kept from an earlier session", { permissionMode: "default", permissionModeSource: "inherited" }],
  ["a mode with no recorded source", { permissionMode: "default" }],
] as const) it(`never replaces ${label} with prepare's default`, async () => {
  openTab(carried);
  view = await mount(<Harness />);
  await answer(0, prepared("bypassPermissions"));
  expect(meta().permissionMode).toBe("default");
});

it("a design /clear keeps the session's mode and never restores the draft that was already sent", async () => {
  openTab({ permissionMode: "bypassPermissions", permissionModeSource: "cache" });
  view = await mount(<Harness />);
  await answer(0, prepared("acceptEdits", { draft: { content: "sent already", attachments: "[]", updatedAt: "" } }));
  expect(textarea().value).toBe("sent already");

  // The design adopts the session its first message created …
  await patch({ sessionId: "design-session", designChatEpoch: 1 });
  expect(getPrepare(TAB)).toBeUndefined();
  expect(isPrepared(TAB)).toBe(false);
  // … and the mode that session ran with is no longer a replaceable default.
  expect(meta()).toMatchObject({ permissionMode: "acceptEdits", permissionModeSource: "inherited" });

  // `/clear` inside the design: same tab id, no session, a remount.
  await patch({ sessionId: undefined, designChatEpoch: 2 });
  expect(bodies).toHaveLength(2); // a fresh prepare for the new stretch, not a join of the old one
  await answer(1, prepared("bypassPermissions"));
  expect(meta().permissionMode).toBe("acceptEdits");
  expect(textarea().value).toBe("");
});
