/**
 * From the socket to the chip: what the server says overrides the effort has to reach the model
 * chip in both of the composer's toolbars, the phone's and the desktop's, which are both mounted
 * and told apart by CSS alone.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom";
import type { EffortStatus } from "../../../src/shared/effort-status";
installDom();
installGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");

// What the CLI answered for `"env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" }` in the user settings.
const GLOBAL_MAX: EffortStatus = {
  env: { value: "max", source: "userSettings", file: "~/.claude/settings.json" },
  observed: { requested: "high", applied: "max", model: "claude-opus-5-5" },
};

let view: Mounted | null = null;
let receive: ((event: MessageEvent) => void) | undefined;
const spies: Array<{ mockRestore(): void }> = [];
function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab tabId="effort-tab" metadata={metadata} />;
}
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
  receive = undefined;
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "effort-tab", tabHistory: ["effort-tab"], tabs: [{ id: "effort-tab", type: "chat", title: "Chat", projectId: "test", closable: true, metadata: { projectName: "test", sessionId: "s1", providerId: "claude" } }] } } });
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/messages")) return Promise.resolve({ messages: [], versionMap: {} });
    if (path.includes("/drafts/")) return Promise.resolve(null);
    if (path.includes("/usage")) return Promise.resolve(null);
    return Promise.resolve([]);
  }), spyOn(api, "post").mockResolvedValue({}), spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined),
  spyOn(WsClient.prototype, "connect").mockImplementation(() => {}), spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
  spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => { receive = undefined; }; }));
});
afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
});
async function frame(data: unknown) { await act(async () => { receive!(new MessageEvent("message", { data: JSON.stringify(data) })); }); }
const chip = (toolbar: "phone" | "desktop") => {
  const box = view!.container.querySelector(toolbar === "phone" ? ".md\\:hidden" : ".md\\:block");
  return box?.querySelector<HTMLButtonElement>('button[aria-label^="Model "]') ?? null;
};

it("shows the effort the CLI runs at in both toolbars, flagged as set outside PPM", async () => {
  view = await mount(<Harness />);
  await frame({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null, model: "claude-opus-5-5", effort: "high", effortStatus: GLOBAL_MAX });
  for (const toolbar of ["phone", "desktop"] as const) {
    expect(chip(toolbar)?.textContent).toBe("Opus 5.5 · Max");
    expect(chip(toolbar)?.getAttribute("aria-label")).toContain("(Effort is set to Max outside PPM)");
  }
});

it("moves with the CLI's answer at the next turn's start", async () => {
  view = await mount(<Harness />);
  await frame({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null, model: "claude-opus-5-5", effort: "high", effortStatus: {} });
  expect(chip("desktop")?.textContent).toBe("Opus 5.5 · High");
  await frame({ type: "effort_status", status: GLOBAL_MAX });
  expect(chip("phone")?.textContent).toBe("Opus 5.5 · Max");
  expect(chip("desktop")?.textContent).toBe("Opus 5.5 · Max");
});
