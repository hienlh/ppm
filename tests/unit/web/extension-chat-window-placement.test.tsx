/**
 * A chat an extension opens from a panel that floats in a window must not land in the tab
 * strip behind that window. With a placement, a desktop shows the chat in a window of its own,
 * beside the panel's and in front of it; a phone keeps today's tab. Drives the real
 * `useExtensionWs` hook against a fake WebSocket.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useExtensionWs } from "../../../src/web/hooks/use-extension-ws.ts";
import { usePanelStore } from "../../../src/web/stores/panel-store";
import { useProjectStore } from "../../../src/web/stores/project-store";
import { frontWindowId, useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { DOCK_PANEL_ID, isWindowPanelId, windowIdFromPanelId } from "../../../src/web/stores/panel-utils";
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
const GRAPH_RECT = { x: 40, y: 50, w: 900, h: 700 };
const realWidth = window.innerWidth;
const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { value, configurable: true });

/** The graph panel `graph-wv-1`, popped out into a window at GRAPH_RECT; answers that window's id. */
function seedGraphWindow(): string {
  const ps = usePanelStore.getState();
  const tabId = ps.openTab({ type: "extension", title: "Graph", projectId: null, closable: true, metadata: { viewType: "graph", panelId: "graph-wv-1", extensionId: "graph", projectName: "proj1" } }, "panel-A");
  return ps.popOutTab(tabId, "panel-A", { closeTabsOnClose: true, rect: GRAPH_RECT })!;
}

beforeEach(() => {
  FakeSocket.instances = [];
  installGlobal("WebSocket", FakeSocket);
  setWidth(1600);
  usePanelStore.setState({
    panels: { "panel-A": emptyPanel("panel-A"), [DOCK_PANEL_ID]: emptyPanel(DOCK_PANEL_ID) },
    grid: [["panel-A"]], focusedPanelId: "panel-A", currentProject: "proj1",
    projectGrids: {}, projectFocused: {}, dock: { visible: false, height: 30 }, projectDock: {},
  });
  useWindowStore.setState({ windows: {}, restored: true, bounds: { w: 1600, h: 900 } });
  useProjectStore.setState({ projects: [{ name: "proj1", path: "/p1" }] as never, activeProject: { name: "proj1", path: "/p1" } as never });
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  setWidth(realWidth);
});
afterAll(() => uninstallDom());

async function receive(messages: Record<string, unknown>[]): Promise<void> {
  const { act } = await import("react");
  mounted ??= await mount(<Bridge />);
  const socket = FakeSocket.instances[0]!;
  await act(async () => {
    for (const message of messages) socket.onmessage?.({ data: JSON.stringify(message) });
    await new Promise((r) => setTimeout(r, 10));
  });
}

const hello = { type: "client:hello", clientId: "me" };
const openChat = (extra: Record<string, unknown>) => ({
  type: "tab:open", tabType: "chat", title: "Mở rộng: AI", projectId: "proj1", closable: true,
  metadata: { projectName: "proj1", sessionId: "sess-1", providerId: "claude" }, ...extra,
});
const beside = { placement: { preferWindow: true, besidePanelId: "graph-wv-1" } };

/** The chat tab's panel, and its window when it has one. */
function chatHome() {
  const entry = Object.values(usePanelStore.getState().panels).find((p) => p.tabs.some((t) => tabSessionId(t) === "sess-1"));
  const windowId = entry ? windowIdFromPanelId(entry.id) : null;
  return { panelId: entry?.id ?? null, windowId, win: windowId ? useWindowStore.getState().windows[windowId] : undefined };
}

describe("a chat opened from a panel in a window", () => {
  it("opens in its own window beside the graph's, in front, and closes with that window", async () => {
    const graphWindow = seedGraphWindow();
    await receive([hello, openChat({ clientId: "me", ...beside })]);

    const { windowId, win } = chatHome();
    expect(windowId).not.toBeNull();
    expect(windowId).not.toBe(graphWindow);
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(windowId);
    expect(win!.rect.x).toBe(GRAPH_RECT.x + GRAPH_RECT.w + 12);
    expect(win!.rect.y).toBe(GRAPH_RECT.y);
    expect(win!.payload?.closeTabsOnClose).toBe(true);
    // The grid keeps focus: the next tab opened without a panel must not land in the window.
    expect(isWindowPanelId(usePanelStore.getState().focusedPanelId)).toBe(false);
  });

  it("moves a chat docked behind the graph into a window, which hands it back when closed", async () => {
    usePanelStore.getState().openTab({ type: "chat", title: "Chat", projectId: "proj1", closable: true, metadata: { projectName: "proj1", sessionId: "sess-1", providerId: "claude" } }, "panel-A");
    seedGraphWindow();
    await receive([hello, openChat({ clientId: "me", ...beside })]);

    const { windowId, win } = chatHome();
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(windowId);
    expect(win!.payload?.originPanelId).toBe("panel-A");
    expect(win!.payload?.closeTabsOnClose).toBeUndefined();
    expect(Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).filter((t) => tabSessionId(t) === "sess-1")).toHaveLength(1);
  });

  it("brings an open chat window forward, out of the dock if minimised, without a second window", async () => {
    seedGraphWindow();
    await receive([hello, openChat({ clientId: "me", ...beside })]);
    const first = chatHome().windowId!;
    useWindowStore.getState().setState(first, "minimized");
    await receive([openChat({ clientId: "me", ...beside })]);

    expect(chatHome().windowId).toBe(first);
    expect(useWindowStore.getState().windows[first]!.state).toBe("normal");
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(first);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(2);
  });

  it("keeps an ordinary tab on a phone", async () => {
    setWidth(390);
    await receive([hello, openChat({ clientId: "me", ...beside })]);
    expect(chatHome().panelId).toBe("panel-A");
    expect(useWindowStore.getState().windows).toEqual({});
  });

  it("keeps an ordinary tab without a placement", async () => {
    seedGraphWindow();
    await receive([hello, openChat({ clientId: "me" })]);
    expect(chatHome().panelId).toBe("panel-A");
  });

  it("keeps a tab in a browser that does not show the calling panel when the request reached every browser", async () => {
    await receive([hello, openChat(beside)]);
    expect(chatHome().panelId).toBe("panel-A");
    expect(useWindowStore.getState().windows).toEqual({});
  });

  it("places a broadcast chat beside the panel in the browser that shows it", async () => {
    seedGraphWindow();
    await receive([hello, openChat(beside)]);
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(chatHome().windowId);
  });
});
