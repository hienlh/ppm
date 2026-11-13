/**
 * A chat an extension opens lands in one browser only — the one the server addressed — and
 * in its own project, as a chat tab the rest of the app recognises by `tabSessionId`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useExtensionWs } from "../../../src/web/hooks/use-extension-ws.ts";
import { usePanelStore } from "../../../src/web/stores/panel-store";
import { useProjectStore } from "../../../src/web/stores/project-store";
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { DOCK_PANEL_ID } from "../../../src/web/stores/panel-utils";
import { tabSessionId } from "../../../src/web/lib/tab-session-id.ts";
import type { Panel } from "../../../src/web/stores/panel-utils";

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

function Bridge() {
  useExtensionWs(true);
  return null;
}

const emptyPanel = (id: string): Panel => ({ id, tabs: [], activeTabId: null, tabHistory: [] });

function seedStores() {
  usePanelStore.setState({
    panels: { "panel-A": emptyPanel("panel-A"), [DOCK_PANEL_ID]: emptyPanel(DOCK_PANEL_ID) },
    grid: [["panel-A"]],
    focusedPanelId: "panel-A",
    currentProject: "proj1",
    projectGrids: {},
    projectFocused: {},
    dock: { visible: false, height: 30 },
    projectDock: {},
  });
  useWindowStore.setState({ windows: {}, restored: true });
  useProjectStore.setState({
    projects: [{ name: "proj1", path: "/p1" }, { name: "proj2", path: "/p2" }] as never,
    activeProject: { name: "proj1", path: "/p1" } as never,
  });
}

let mounted: Mounted | null = null;
beforeEach(() => {
  FakeSocket.instances = [];
  installGlobal("WebSocket", FakeSocket);
  seedStores();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
afterAll(() => uninstallDom());

const chatTabs = () => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs.filter((t) => t.type === "chat"));

async function receive(messages: Record<string, unknown>[]): Promise<void> {
  const { act } = await import("react");
  mounted ??= await mount(<Bridge />);
  const socket = FakeSocket.instances[0]!;
  await act(async () => {
    for (const message of messages) socket.onmessage?.({ data: JSON.stringify(message) });
    await new Promise((r) => setTimeout(r, 10));
  });
}

const open = (clientId: string, projectName = "proj1") => ({
  type: "tab:open", tabType: "chat", title: "Graph manager", projectId: projectName, closable: true, clientId,
  metadata: { projectName, sessionId: "sess-1", providerId: "claude" },
});

describe("tab:open addressed to one browser", () => {
  it("opens the chat tab in the addressed browser, carrying the project and the session", async () => {
    await receive([{ type: "client:hello", clientId: "me" }, open("me")]);
    const tabs = chatTabs();
    expect(tabs).toHaveLength(1);
    expect(tabSessionId(tabs[0])).toBe("sess-1");
    expect(tabs[0]!.metadata).toMatchObject({ projectName: "proj1", sessionId: "sess-1", providerId: "claude" });
  });

  it("is ignored by a browser the message was not addressed to", async () => {
    await receive([{ type: "client:hello", clientId: "me" }, open("someone-else")]);
    expect(chatTabs()).toEqual([]);
  });

  it("switches to the chat's project first", async () => {
    await receive([{ type: "client:hello", clientId: "me" }, open("me", "proj2")]);
    expect(usePanelStore.getState().currentProject).toBe("proj2");
    expect(useProjectStore.getState().activeProject?.name).toBe("proj2");
    const tabs = chatTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.metadata?.projectName).toBe("proj2");
  });
});
