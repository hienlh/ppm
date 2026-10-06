/**
 * Remote Access (Settings) and Forward a Port (the sidebar's Port Forwarding panel) in the
 * palette, on a desktop and on a phone. The palette searches `keywords` alone when an entry has
 * them, so an entry's own label has to lead its keywords or a neighbour that happens to list the
 * word ("PPM Cloud & Share" lists "remote") ranks above it.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { useRemoteAccessTab } = await import("../../../src/web/components/settings/remote-access/remote-access-tab-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { OPEN_NAVIGATION } = await import("../../../src/web/components/database/db-sidebar-reveal");
const apiClient = await import("../../../src/web/lib/api-client");

const realWidth = window.innerWidth;
afterAll(uninstallDom);
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  useRemoteAccessTab.setState({ tab: "public-link" });
});
afterEach(() => Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }));

/** Result labels, top to bottom. */
const labels = (container: HTMLElement) => [...container.querySelectorAll("button span.truncate")].map((s) => s.textContent);

async function search(query: string) {
  const open = spyOn(useWindowStore.getState(), "open").mockReturnValue("win-1");
  const get = spyOn(apiClient.api, "get").mockResolvedValue([] as never);
  const view = await mount(<CommandPalette open onClose={() => {}} initialQuery={query} />);
  return {
    view,
    open,
    async done() { await view.unmount(); open.mockRestore(); get.mockRestore(); },
  };
}

it("ranks Remote Access first for “remote” and opens it on its first tab", async () => {
  const s = await search("remote");
  try {
    expect(labels(s.view.container)[0]).toBe("Remote Access");
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Remote Access"))!;
    await click(row);
    expect(s.open).toHaveBeenCalledWith("settings", { category: "remote-access" });
    // The sub-tab is left where the user last had it.
    expect(useRemoteAccessTab.getState().tab).toBe("public-link");
  } finally {
    await s.done();
  }
});

it("finds Remote Access by the old panel's name", async () => {
  const s = await search("tunnel");
  try {
    expect(labels(s.view.container).slice(0, 2).sort()).toEqual(["Forward a Port", "Remote Access"]);
  } finally {
    await s.done();
  }
});

it("opens “Forward a Port” in the sidebar, expanding a collapsed one, and not in Settings", async () => {
  const before = useSettingsStore.getState();
  const setTab = spyOn(before, "setSidebarActiveTab").mockImplementation(() => {});
  const toggle = spyOn(before, "toggleSidebar").mockImplementation(() => {});
  useSettingsStore.setState({ sidebarCollapsed: true });
  const s = await search("port forwarding");
  try {
    expect(labels(s.view.container)[0]).toBe("Forward a Port");
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Forward a Port"))!;
    await click(row);
    expect(setTab).toHaveBeenCalledWith("tunnels");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(s.open).not.toHaveBeenCalled();
  } finally {
    await s.done();
    setTab.mockRestore();
    toggle.mockRestore();
    // The state object the spies were put on, whole: a setState since then copied them onward.
    useSettingsStore.setState(before, true);
  }
});

it("opens “Forward a Port” in the phone's drawer, leaving the desktop sidebar's section alone", async () => {
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  const before = useSettingsStore.getState();
  const setTab = spyOn(before, "setSidebarActiveTab").mockImplementation(() => {});
  const asked: unknown[] = [];
  const listen = (e: Event) => asked.push((e as CustomEvent).detail);
  window.addEventListener(OPEN_NAVIGATION, listen);
  const s = await search("forward");
  try {
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Forward a Port"))!;
    await click(row);
    expect(asked).toEqual([{ tab: "tunnels" }]);
    expect(setTab).not.toHaveBeenCalled();
  } finally {
    await s.done();
    window.removeEventListener(OPEN_NAVIGATION, listen);
    setTab.mockRestore();
    useSettingsStore.setState(before, true);
  }
});
