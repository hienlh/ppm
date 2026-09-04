/**
 * Titlebar text resolution per window kind.
 *
 * The `tab-host` case is the one with a moving part: `popOutTab` writes the detached
 * tab's title into the window payload, and this is what reads it back. The generic
 * "Tab" is a fallback for a window restored before its layout has loaded, not the
 * normal case — eight detached tabs must not share one titlebar.
 */
import { describe, it, expect } from "bun:test";
import { windowTitle } from "../../../src/web/components/floating-window/window-content-registry";

describe("windowTitle", () => {
  it("uses the detached tab's title for a tab-host window", () => {
    expect(windowTitle("tab-host", { originPanelId: "panel-A", title: "server.ts" })).toBe("server.ts");
  });

  it("falls back to a generic name for a tab-host window with no resolved tab", () => {
    expect(windowTitle("tab-host", { originPanelId: "panel-A" })).toBe("Tab");
    expect(windowTitle("tab-host", undefined)).toBe("Tab");
    // A whitespace-only title is no title at all.
    expect(windowTitle("tab-host", { title: "   " })).toBe("Tab");
  });

  it("ignores a non-string title", () => {
    expect(windowTitle("tab-host", { title: 42 })).toBe("Tab");
  });

  it("names a team-member window after the member", () => {
    expect(windowTitle("team-member", { memberName: "fixer" })).toBe("Session — fixer");
    expect(windowTitle("team-member", {})).toBe("Team member");
  });

  it("names an explorer window after the last path segment", () => {
    expect(windowTitle("explorer", { path: "/home/victor/ppm" })).toBe("ppm");
    expect(windowTitle("explorer", { path: "C:\\Users\\PC" })).toBe("PC");
    expect(windowTitle("explorer", {})).toBe("Explorer");
  });

  it("names the system monitor", () => {
    expect(windowTitle("system-monitor")).toBe("System Monitor");
  });
});
