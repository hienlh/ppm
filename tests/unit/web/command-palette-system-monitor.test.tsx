/**
 * A phone had no way into the System Monitor: its one entry, the CPU/MEM chip, lives in the
 * status bar, which is hidden below md. The palette is what a phone's "New tab" button opens,
 * so its command is the phone's way in — a tab there, the floating window on a desktop.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const apiClient = await import("../../../src/web/lib/api-client");

// `useIsMobile` reads `window.innerWidth`, so a phone is one property away.
const realWidth = window.innerWidth;
const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { value, configurable: true });
afterAll(uninstallDom);
afterEach(() => setWidth(realWidth));

/** The result row whose rendered text contains `text`. */
function row(container: HTMLElement, text: string): Element {
  const rows = [...container.querySelectorAll("button")];
  const found = rows.find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no result row for ${text}; rows: ${rows.map((b) => b.textContent).join(" | ")}`);
  return found;
}

it("opens the System Monitor as a tab on a phone", async () => {
  setWidth(390);
  const openTab = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-1");
  const openWindow = spyOn(useWindowStore.getState(), "open");
  const get = spyOn(apiClient.api, "get").mockResolvedValue([] as never);
  let closed = 0;
  const view = await mount(<CommandPalette open onClose={() => { closed++; }} initialQuery="monitor" />);
  try {
    await click(row(view.container, "System Monitor"));
    expect(openTab).toHaveBeenCalledWith({ type: "system-monitor", title: "System Monitor", projectId: null, closable: true });
    expect(openWindow).not.toHaveBeenCalled();
    expect(closed).toBe(1);
  } finally {
    await view.unmount(); openTab.mockRestore(); openWindow.mockRestore(); get.mockRestore();
  }
});

it("opens the floating window on a desktop", async () => {
  setWidth(1280);
  const openTab = spyOn(useTabStore.getState(), "openTab");
  const openWindow = spyOn(useWindowStore.getState(), "open").mockReturnValue("win-1");
  const get = spyOn(apiClient.api, "get").mockResolvedValue([] as never);
  const view = await mount(<CommandPalette open onClose={() => {}} initialQuery="task manager" />);
  try {
    await click(row(view.container, "System Monitor"));
    expect(openWindow).toHaveBeenCalledWith("system-monitor");
    expect(openTab).not.toHaveBeenCalled();
  } finally {
    await view.unmount(); openTab.mockRestore(); openWindow.mockRestore(); get.mockRestore();
  }
});
