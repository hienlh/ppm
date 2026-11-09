// A floating window's body is a DOM node the frame appends by hand (it has to be, to travel
// into a picture-in-picture document), so React does not know it is there. When the titlebar
// is mounted again — the skin resolves to macOS on the first paint, then to Windows once the
// host's platform arrives — React inserts it before its next React-owned sibling, and a
// maximized or snapped window has none (no resize handles): it was appended after the body,
// and the titlebar drew at the bottom of the window.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { WindowRuntimeState, WindowVisualState } from "../../../src/web/components/floating-window/window-store-types";

installDom();
afterAll(uninstallDom);

const { FloatingWindow } = await import("../../../src/web/components/floating-window/floating-window");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { Square } = await import("../../../src/web/lib/icons");

let view: Mounted | null = null;
beforeEach(() => useSettingsStore.setState({ explorerSkin: "macos" }));
afterEach(async () => {
  await view?.unmount();
  view = null;
  useSettingsStore.setState({ explorerSkin: "auto" });
});

function windowOf(state: WindowVisualState): WindowRuntimeState {
  return { id: "w1", kind: "tab-host", rect: { x: 10, y: 10, w: 600, h: 400 }, rank: 0, opened: 0, state };
}

async function titlebarComesFirstAfterSkinSwap(state: WindowVisualState): Promise<void> {
  view = await mount(createElement(FloatingWindow, {
    win: windowOf(state),
    bounds: { w: 1280, h: 800 },
    title: "Billing",
    identity: { icon: Square, tone: "var(--primary)", busy: false, allowPip: false },
    focused: true,
    getScale: () => 1,
    onGestureActive: () => {},
    children: createElement("p", { id: "content" }, "content"),
  }));
  const { act } = await import("react");
  await act(async () => { useSettingsStore.setState({ explorerSkin: "windows" }); });

  const root = view.container.querySelector('[aria-roledescription="window"]')!;
  const titlebar = root.querySelector('[role="toolbar"]')!;
  const body = view.container.querySelector("#content")!.closest(".flex-1")!;
  expect(titlebar.getAttribute("data-skin")).toBe("windows");
  // DOCUMENT_POSITION_FOLLOWING: the body comes after the titlebar.
  expect(titlebar.compareDocumentPosition(body) & 4).toBe(4);
}

it("keeps the titlebar above the body when a maximized window's skin changes", async () => {
  await titlebarComesFirstAfterSkinSwap("maximized");
});

it("keeps the titlebar above the body when a snapped window's skin changes", async () => {
  await titlebarComesFirstAfterSkinSwap("snapped");
});

it("keeps the titlebar above the body when a normal window's skin changes", async () => {
  await titlebarComesFirstAfterSkinSwap("normal");
});
