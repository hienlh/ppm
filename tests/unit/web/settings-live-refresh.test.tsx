/**
 * `settings:changed {section}` from the server (another device, the `ppm` CLI): the theme is
 * re-applied and keybindings reloaded whether or not Settings is open, and an open pane that asked
 * for that section through `useSettingsChanged` reads it again — and only for its own sections.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();

const { handleSettingsChanged } = await import("../../../src/web/lib/settings-live-refresh.ts");
const { useSettingsChanged } = await import("../../../src/web/hooks/use-settings-changed.ts");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store.ts");
const { useKeybindingsStore } = await import("../../../src/web/stores/keybindings-store.ts");
const { act } = await import("react");

// The stores are module singletons shared with every later file in the run: the reloaded
// "open-chat" binding otherwise reaches the command palette's tests as its shortcut.
const settingsBefore = useSettingsStore.getState();
const keybindingsBefore = useKeybindingsStore.getState();
afterAll(() => {
  useSettingsStore.setState(settingsBefore, true);
  useKeybindingsStore.setState(keybindingsBefore, true);
  uninstallDom();
});

const realFetch = globalThis.fetch;
let requests: string[] = [];

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const data = url.endsWith("/api/settings/theme") ? { theme: { style: "slate", mode: "dark" } }
      : url.endsWith("/api/settings/keybindings") ? { "open-chat": "Mod+Shift+L" }
        : {};
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

const settle = async () => { await act(async () => { await Bun.sleep(10); }); };

describe("settings live refresh", () => {
  it("re-applies the server's theme with no pane open", async () => {
    useSettingsStore.getState().setThemeFromPayload({ style: "aurora", mode: "light" });
    handleSettingsChanged("theme");
    await settle();
    expect(useSettingsStore.getState().themeStyle).toBe("slate");
    expect(useSettingsStore.getState().themeMode).toBe("dark");
  });

  it("reloads keybindings", async () => {
    handleSettingsChanged("keybindings");
    await settle();
    expect(useKeybindingsStore.getState().getBinding("open-chat")).toBe("Mod+Shift+L");
  });

  it("lets an open pane read its own section again, and only its own", async () => {
    let hits = 0;
    function Pane() {
      useSettingsChanged(["query-audit", "session-trace"], () => { hits++; });
      return null;
    }
    view = await mount(<Pane />);
    handleSettingsChanged("session-trace");
    await settle();
    expect(hits).toBe(1);
    handleSettingsChanged("proxy");
    await settle();
    expect(hits).toBe(1);
    await view.unmount();
    view = null;
    handleSettingsChanged("query-audit");
    await settle();
    expect(hits).toBe(1);
  });
});
