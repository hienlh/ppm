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
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { KEY_ACTIONS, parseCombo } = await import("../../../src/web/stores/keybindings-store");
const { isMinimalKeyAction } = await import("../../../src/web/lib/minimal-mode");
const { KeyboardShortcutsSection } = await import("../../../src/web/components/settings/keyboard-shortcuts-section");
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

test("minimal mode answers exactly the shortcuts Settings lists for it", async () => {
  useSettingsStore.setState({ minimalMode: true });
  const view = await mount(<Probe />);
  try {
    for (const action of KEY_ACTIONS) {
      if (!action.defaultKey) continue;
      const c = parseCombo(action.defaultKey);
      const claimed = press(document.body, { key: c.key, ctrlKey: c.ctrl, metaKey: c.meta, altKey: c.alt, shiftKey: c.shift });
      expect({ id: action.id, claimed }).toEqual({ id: action.id, claimed: isMinimalKeyAction(action.id) });
    }
  } finally {
    await view.unmount();
  }
});

test("minimal mode switches projects with Mod+1..9", async () => {
  const projects = [{ name: "one", path: "/p/one" }, { name: "two", path: "/p/two" }];
  useSettingsStore.setState({ minimalMode: true });
  useProjectStore.setState({ projects: projects as never, activeProject: projects[0] as never });
  const view = await mount(<Probe />);
  try {
    expect(press(document.body, { key: "2", ctrlKey: true })).toBe(true);
    expect(useProjectStore.getState().activeProject?.name).toBe("two");
  } finally {
    await view.unmount();
  }
});

test("Settings lists every shortcut in full mode and only the answered ones in minimal mode", async () => {
  const listed = async () => {
    const view = await mount(<KeyboardShortcutsSection />);
    const labels = [...document.querySelectorAll("span.text-xs.text-foreground")].map((el) => el.textContent ?? "");
    await view.unmount();
    return labels.sort();
  };
  expect(await listed()).toEqual(KEY_ACTIONS.map((a) => a.label).sort());
  useSettingsStore.setState({ minimalMode: true });
  const minimal = await listed();
  expect(minimal).toEqual(KEY_ACTIONS.filter((a) => isMinimalKeyAction(a.id)).map((a) => a.label).sort());
  expect(minimal).toContain("Switch to Project 1");
  for (const hidden of ["Command Palette", "Toggle Terminal Panel", "Open Terminal Tab", "Git Status (sidebar)", "Problems", "Compare Files..."]) {
    expect(minimal).not.toContain(hidden);
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
