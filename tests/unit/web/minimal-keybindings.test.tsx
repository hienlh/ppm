/**
 * Minimal mode's shortcuts follow full mode's rule for text fields: inside the chat composer or
 * the editor only the locked ones fire. Without it, Ctrl+Shift+V (paste as plain text) toggled
 * the mic instead of pasting, and Ctrl+L in the composer opened another chat.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
installGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, data: null })));
const { useGlobalKeybindings } = await import("../../../src/web/hooks/use-global-keybindings");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
afterEach(() => useSettingsStore.setState({ minimalMode: false }));

function Probe() {
  useGlobalKeybindings();
  return null;
}

/** Dispatches a keydown and answers whether a handler claimed it. */
function press(target: EventTarget, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

test("inside a text field minimal mode leaves paste and typing alone", async () => {
  useSettingsStore.setState({ minimalMode: true });
  const view = await mount(<Probe />);
  const field = document.createElement("textarea");
  document.body.appendChild(field);
  let voice = 0;
  const onVoice = () => { voice++; };
  window.addEventListener("toggle-voice-input", onVoice);
  try {
    expect(press(field, { key: "V", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press(field, { key: "l", ctrlKey: true })).toBe(false);
    expect(voice).toBe(0);
    // Outside a text field the same shortcut still toggles voice input.
    expect(press(document.body, { key: "V", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(voice).toBe(1);
  } finally {
    window.removeEventListener("toggle-voice-input", onVoice);
    field.remove();
    await view.unmount();
  }
});

test("minimal mode keeps the Search sidebar shortcut", async () => {
  useSettingsStore.setState({ minimalMode: true, sidebarActiveTab: "explorer", sidebarCollapsed: false });
  const view = await mount(<Probe />);
  try {
    expect(press(document.body, { key: "F", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(useSettingsStore.getState().sidebarActiveTab).toBe("search");
  } finally {
    await view.unmount();
  }
});
