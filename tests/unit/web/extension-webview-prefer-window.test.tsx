/**
 * A panel created with `preferWindow` opens in a floating window on a desktop and stays a
 * tab on a phone. Drives the real `useExtensionWs` hook against a fake WebSocket: the browser
 * tab runs the command (which marks the view as its own), then the server's `webview:create`
 * arrives.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useExtensionWs } from "../../../src/web/hooks/use-extension-ws.ts";
import { usePanelStore } from "../../../src/web/stores/panel-store";
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { DOCK_PANEL_ID, isWindowPanelId } from "../../../src/web/stores/panel-utils";
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
}

const realWidth = window.innerWidth;
const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { value, configurable: true });

let mounted: Mounted | null = null;
/** The store's own action, wrapped per test so the call is observed and still takes effect. */
const realPopOutTab = usePanelStore.getState().popOutTab;
let popOutTab: ReturnType<typeof mock>;

beforeEach(() => {
  FakeSocket.instances = [];
  installGlobal("WebSocket", FakeSocket);
  seedStores();
  popOutTab = mock((...args: Parameters<typeof realPopOutTab>) => realPopOutTab(...args));
  usePanelStore.setState({ popOutTab: popOutTab as unknown as typeof realPopOutTab });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  setWidth(realWidth);
});

afterAll(() => {
  usePanelStore.setState({ popOutTab: realPopOutTab });
  uninstallDom();
});

async function openPanel(create: Record<string, unknown>, dispatched = true): Promise<void> {
  const { act } = await import("react");
  mounted = await mount(<Bridge />);
  const socket = FakeSocket.instances[0]!;
  await act(async () => {
    if (dispatched) {
      window.dispatchEvent(new CustomEvent("ext:command:execute", { detail: { command: "probe.view", args: [] } }));
    }
    socket.onmessage?.({
      data: JSON.stringify({ type: "webview:create", panelId: "probe-wv-1", extensionId: "probe", viewType: "probe.view", title: "Probe", ...create }),
    });
  });
}

const extensionTabs = () => Object.entries(usePanelStore.getState().panels)
  .flatMap(([panelId, p]) => p.tabs.filter((t) => t.type === "extension").map((t) => ({ panelId, id: t.id })));

describe("webview:create with preferWindow", () => {
  it("pops the new tab out into a window on a desktop", async () => {
    setWidth(1280);
    await openPanel({ preferWindow: true });

    expect(popOutTab).toHaveBeenCalledTimes(1);
    const [tabId, , options] = popOutTab.mock.calls[0] as [string, string, { closeTabsOnClose?: boolean; rect?: object }];
    expect(options.closeTabsOnClose).toBe(true);
    expect(options.rect).toBeTruthy();
    const tabs = extensionTabs();
    expect(tabs.map((t) => t.id)).toEqual([tabId]);
    expect(isWindowPanelId(tabs[0]!.panelId)).toBe(true);
  });

  it("keeps a tab on a phone", async () => {
    setWidth(390);
    await openPanel({ preferWindow: true });

    expect(popOutTab).not.toHaveBeenCalled();
    expect(extensionTabs().map((t) => t.panelId)).toEqual(["panel-A"]);
  });

  it("changes nothing for a panel that does not ask for a window", async () => {
    setWidth(1280);
    await openPanel({});

    expect(popOutTab).not.toHaveBeenCalled();
    expect(extensionTabs().map((t) => t.panelId)).toEqual(["panel-A"]);
  });

  it("does nothing in a browser tab that did not run the command", async () => {
    setWidth(1280);
    await openPanel({ preferWindow: true }, false);

    expect(popOutTab).not.toHaveBeenCalled();
    expect(extensionTabs()).toEqual([]);
  });
});
