import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WEB_BROWSER_SETTINGS,
  parseWebBrowserSettings,
  webBrowserTurnedOn,
} from "../../../src/shared/web-browser-settings.ts";

describe("parseWebBrowserSettings", () => {
  test("nothing stored gives the defaults and leaves the question open", () => {
    const s = parseWebBrowserSettings(undefined);
    expect(s).toEqual({ ...DEFAULT_WEB_BROWSER_SETTINGS });
    expect("enabled" in s).toBe(false);
    expect(webBrowserTurnedOn(s)).toBe(false);
  });

  test("the user's choices are the defaults: localhost, LAN, public link, sound and AI all on", () => {
    const s = parseWebBrowserSettings({});
    expect(s.allowLocalhost && s.allowLan && s.allowPublicTunnel && s.audio && s.aiControl).toBe(true);
  });

  test("numbers are clamped and rounded, garbage falls back", () => {
    const s = parseWebBrowserSettings({ maxTabs: 99, idleStopMinutes: 0.4, fpsCap: "fast", jpegQuality: 70.6 });
    expect(s.maxTabs).toBe(8);
    expect(s.idleStopMinutes).toBe(2);
    expect(s.fpsCap).toBe(DEFAULT_WEB_BROWSER_SETTINGS.fpsCap);
    expect(s.jpegQuality).toBe(71);
  });

  test("an explicit answer is kept, a non-boolean is not", () => {
    expect(parseWebBrowserSettings({ enabled: true }).enabled).toBe(true);
    expect(parseWebBrowserSettings({ enabled: false }).enabled).toBe(false);
    expect("enabled" in parseWebBrowserSettings({ enabled: "yes" })).toBe(false);
  });

  test("unknown keys are dropped and browserPath must be a non-empty string", () => {
    const s = parseWebBrowserSettings({ browserPath: "  ", evil: 1 }) as unknown as Record<string, unknown>;
    expect(s.browserPath).toBeNull();
    expect("evil" in s).toBe(false);
    expect(parseWebBrowserSettings({ browserPath: "C:/x/chrome.exe" }).browserPath).toBe("C:/x/chrome.exe");
  });
});
