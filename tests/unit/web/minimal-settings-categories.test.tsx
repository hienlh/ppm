import { afterAll, afterEach, expect, test, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, installGlobal } from "../../helpers/react-dom";
installDom();
afterAll(uninstallDom);
const React = await import("react");
const { act } = React;
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { SettingsBody } = await import("../../../src/web/components/settings/settings-body");
const { SETTINGS_NAVIGATE_EVENT, resolveSettingsCategory, SETTINGS_CATEGORIES } = await import("../../../src/web/components/settings/settings-categories");
const { SECTIONS, preloadSettingsSections } = await import("../../../src/web/components/settings/settings-section-content");
afterEach(() => useSettingsStore.setState({ minimalMode: false }));

test("minimal Settings retains its original shell and chat categories while restored/linked disabled panes never fetch", async () => {
  useSettingsStore.setState({ minimalMode: true });
  const requests: string[] = [];
  installGlobal("fetch", async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ ok: true, data: {} }), { headers: { "Content-Type": "application/json" } });
  });
  await SECTIONS.general.preload();
  const rendered = await mount(<SettingsBody initialCategory="extensions" />);
  try {
    expect(rendered.container.querySelector('[data-testid="settings-window"]')?.getAttribute("data-category")).toBe("general");
    for (const id of ["general", "appearance", "ai-provider", "accounts", "voice", "notifications", "remote-access", "shortcuts", "files"]) {
      expect(rendered.container.querySelector(`[data-testid="settings-rail-${id}"]`)).not.toBeNull();
    }
    for (const id of ["extensions", "tools", "design", "database-drivers", "language-servers", "remote-desktop", "query-audit", "ppmbot", "jira", "proxy", "schedules"]) {
      expect(rendered.container.querySelector(`[data-testid="settings-rail-${id}"]`)).toBeNull();
    }
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SETTINGS_NAVIGATE_EVENT, { detail: "database-drivers" }));
    });
    expect(rendered.container.querySelector('[data-testid="settings-window"]')?.getAttribute("data-category")).toBe("general");
    expect(requests.filter((url) => /extensions|\/db|schedules/.test(url))).toEqual([]);
    expect(resolveSettingsCategory("extensions", false)).toBe("extensions");
  } finally { await rendered.unmount(); }
});

test("minimal settings preloading also skips disabled panes", async () => {
  useSettingsStore.setState({ minimalMode: true });
  const spies = new Map(SETTINGS_CATEGORIES.map(({ id }) => [id, spyOn(SECTIONS[id], "preload").mockResolvedValue()]));
  try {
    await preloadSettingsSections();
    expect(spies.get("accounts")).toHaveBeenCalledTimes(1);
    expect(spies.get("appearance")).toHaveBeenCalledTimes(1);
    expect(spies.get("database-drivers")).not.toHaveBeenCalled();
    expect(spies.get("tools")).not.toHaveBeenCalled();
    expect(spies.get("extensions")).not.toHaveBeenCalled();
  } finally { for (const spy of spies.values()) spy.mockRestore(); }
});


test("minimal Remote Access preserves public access controls but never mounts restored review hosting", async () => {
  useSettingsStore.setState({ minimalMode: true });
  const { RemoteAccessSettingsSection } = await import("../../../src/web/components/settings/remote-access/remote-access-settings-section");
  const { useRemoteAccessTab } = await import("../../../src/web/components/settings/remote-access/remote-access-tab-store");
  useRemoteAccessTab.setState({ tab: "review-links" });
  const requests: string[] = [];
  installGlobal("fetch", async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ ok: false, error: "test unavailable" }), { status: 503 });
  });
  const rendered = await mount(<RemoteAccessSettingsSection />);
  try {
    expect(rendered.container.querySelector('[data-testid="remote-access-tab-review-links"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="remote-access-tab-public-link"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="remote-access"]')?.getAttribute("data-tab")).toBe("tailscale");
    expect(useRemoteAccessTab.getState().tab).toBe("review-links");
    expect(requests.some((url) => url.includes("share-host"))).toBe(false);
  } finally {
    await rendered.unmount();
    useRemoteAccessTab.setState({ tab: "tailscale" });
  }
});
